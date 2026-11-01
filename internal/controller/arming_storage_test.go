package controller

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/mattn/go-sqlite3"
)

func TestArmRecoversCompletedTeamStorageHoldDuringMaintenance(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	setTestProfile(app, "web")
	p.shares = 30
	teams := []M{}
	ids := map[string]bool{}
	for i := 0; i < 40; i++ {
		id := uuid()
		if i == 0 {
			id = testTeam
		}
		ids[id] = true
		raw := p.rawTeam()
		raw["id"], raw["status"] = id, "COMPLETED"
		teams = append(teams, raw)
		o := M{"id": fmt.Sprintf("completed-%d", i), "externalId": id, "packageId": id, "mode": "live", "kind": "team", "source": "NiceHash import", "status": "COMPLETED", "costBtc": 300000, "feeBtc": 0, "refundBtc": 0, "shares": 30, "createdAt": "2026-10-30T12:00:00Z"}
		if i == 0 {
			o["syncPending"] = M{"blocking": true, "stage": "team-detail", "reason": "database is locked", "since": "2026-10-31T19:23:28Z"}
		}
		app.Store.Save("orders", o)
	}
	interceptProvider(app, func(r *http.Request) *http.Response {
		if strings.HasSuffix(r.URL.Path, "/hashpower/solo/shared/order") {
			return mockJSON(200, M{"list": teams})
		}
		if strings.Contains(r.URL.Path, "/hashpower/solo/shared/order/") {
			id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			if ids[id] {
				raw := p.rawTeam()
				raw["id"], raw["status"] = id, "COMPLETED"
				return mockJSON(200, raw)
			}
		}
		return nil
	})
	tg := telegramMock(t, app)
	enableTelegram(app, M{"purchases": false, "dailyReports": false})
	now := time.Now()
	target := telegramTarget(app.Telegram.config(), app.Telegram.credentials())
	for i := 0; i < 20; i++ {
		app.Telegram.enqueue(fmt.Sprintf("storage-fixture:%d", i), "purchase", "Synthetic maintenance alert", target, now)
	}
	cookie := login(t, app)
	maintenanceDone, notificationsDone := make(chan any, 1), make(chan any, 1)
	go func() {
		maintenanceDone <- attempt(func() {
			for i := 0; i < 80; i++ {
				var owner string
				must(app.Store.q.QueryRow("SELECT COALESCE(owner,'') FROM lease WHERE id=1").Scan(&owner))
				app.Store.Renew(owner)
				app.Store.Set("maintenance-status", M{"iteration": i})
			}
		})
	}()
	go func() {
		notificationsDone <- attempt(func() {
			for i := 0; i < 20; i++ {
				app.Telegram.Background(context.Background(), now.Add(time.Duration(i)*time.Second))
			}
		})
	}()
	w := httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
	maintenanceError := databaseResult(t, maintenanceDone, "lock renewal")
	notificationError := databaseResult(t, notificationsDone, "notification delivery")
	assert(t, w.Code == 200, "Arming still blocked by completed-team storage hold: %s", w.Body)
	assert(t, maintenanceError == nil && notificationError == nil, "Background database write failed: %v / %v", maintenanceError, notificationError)
	rt := obj(app.Store.Get("runtime"))
	settings := obj(app.Store.Get("settings"))
	assert(t, b(rt["historyComplete"]) && b(rt["buyingReady"]) && len(maps(rt["syncWarnings"])) == 0, "Successful save did not clear stale history warning: %s", encode(rt))
	orders := app.Store.List("orders")
	assert(t, len(orders) == 40 && n(totals(orders, nil, "live")["spend"]) == 12000000 && orders[0]["syncPending"] == nil, "Recovery changed or duplicated committed spending")
	assert(t, b(settings["liveArmed"]) && !b(settings["running"]) && len(p.posts) == 0, "Arming started buying or replayed a purchase")
	assert(t, len(tg.snapshot()) == 20, "Concurrent notification writes lost or duplicated deliveries")
}

func TestStorageFailuresRemainBlockingAndExplainArmingReason(t *testing.T) {
	err := sqlite3.Error{Code: sqlite3.ErrBusy, ExtendedCode: sqlite3.ErrBusySnapshot}
	details := databaseFailure(fmt.Errorf("import failed: %w", err))
	assert(t, s(details["source"]) == "database" && n(details["dbCode"]) == 5 && n(details["dbExtendedCode"]) == 517, "Missing SQLite diagnostic codes: %s", encode(details))
	rt := M{"historyComplete": false, "buyingReady": false, "syncWarnings": []M{merge(details, M{"blocking": true, "stage": "team-detail", "reason": "database is locked"})}}
	message := armingHistoryError(rt)
	assert(t, !buyingHistoryReady(rt) && strings.Contains(message, "local database") && strings.Contains(message, "database is locked"), "Storage failure bypassed the guard or hid its cause: %s", message)
	d := syncDiagnostics(M{"runtime": rt})
	warning := maps(d["syncWarnings"])[0]
	assert(t, n(warning["dbExtendedCode"]) == 517 && s(warning["source"]) == "database", "Storage diagnosis was dropped from export")
	assert(t, databaseFailure(&APIError{Method: "GET", HTTPStatus: 404}) == nil, "API failure was labeled a database failure")
}

func TestArmingDoesNotBypassStorageFailureDuringReadFallback(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 1, "Fixture did not buy")
	p.shares = 2 // one additional share bought outside the application
	interceptProvider(app, func(r *http.Request) *http.Response {
		if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/shared/order/"+testTeam) {
			return mockJSON(503, M{"errors": []M{{"code": 1, "message": "Temporary detail outage"}}})
		}
		return nil
	})
	app.Store.Exec(`CREATE TRIGGER block_increased_cost BEFORE UPDATE ON orders WHEN CAST(json_extract(NEW.data,'$.costBtc') AS INTEGER)>CAST(json_extract(OLD.data,'$.costBtc') AS INTEGER) BEGIN SELECT RAISE(ABORT,'fixture ledger write blocked'); END`)
	cookie := login(t, app)
	w := httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
	rt := obj(app.Store.Get("runtime"))
	warnings := maps(rt["syncWarnings"])
	assert(t, w.Code == 400 && strings.Contains(w.Body.String(), "local database") && !b(obj(app.Store.Get("settings"))["liveArmed"]) && !b(rt["buyingReady"]), "Failed cost save was bypassed: %s", w.Body)
	assert(t, len(warnings) == 1 && s(warnings[0]["source"]) == "database" && s(warnings[0]["stage"]) == "team-storage" && money(app.Store.List("orders")[0], "costBtc") == 10000, "Storage failure was disguised as a harmless API refresh: %s", encode(rt))
	app.Store.Exec("DROP TRIGGER block_increased_cost")
	w = httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
	assert(t, w.Code == 200 && b(obj(app.Store.Get("settings"))["liveArmed"]) && !b(obj(app.Store.Get("settings"))["running"]) && money(app.Store.List("orders")[0], "costBtc") == 20000, "Recovered save did not enable arming with the full commitment: %s", w.Body)
	assert(t, len(p.posts) == 1, "Arming or storage recovery replayed a purchase")
}
