package controller

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestArmingAfterTeamImportArchivesAnOwnershipReviewDuplicate(t *testing.T) {
	for _, market := range []string{"BTC", "USDT"} {
		t.Run(market, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			configureLive(app, true, false)
			price := int64(10000)
			if market == "USDT" {
				configureUSDT(app, p, true, false)
				price = Sat
			}
			p.shares = 1
			execution := "55555555-5555-4555-8555-555555555555"
			app.Store.Save("orders", fundingRecord(market, M{"id": "old-execution", "externalId": execution, "mode": "live", "kind": "solo", "status": "COMPLETED", "source": "NiceHash import", "costBtc": 68 * price, "createdAt": stamp(), "attribution": M{"state": "review", "reason": "Original shared execution awaiting ownership"}}))
			app.Store.Save("rewards", M{"id": "old-whole-block", "orderId": "old-execution", "coin": "BCH", "amount": 312500000, "valueBtc": 1000000, "valueUsdt": 80 * Sat, "confirmed": true, "createdAt": stamp()})
			interceptProvider(app, func(r *http.Request) *http.Response {
				if strings.Contains(r.URL.Path, "/hashpower/solo/shared/order") {
					raw := p.rawTeam()
					raw["status"] = "COMPLETED"
					raw["orderDetails"] = M{"id": execution, "status": "COMPLETED"}
					if strings.HasSuffix(r.URL.Path, "/shared/order") {
						return mockJSON(200, M{"list": []M{raw}})
					}
					if strings.HasSuffix(r.URL.Path, "/shared/order/"+testTeam) {
						return mockJSON(200, raw)
					}
				}
				return nil
			})
			cookie := login(t, app)
			w := httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
			rt := obj(app.Store.Get("runtime"))
			assert(t, b(rt["historyComplete"]) && b(rt["buyingReady"]) && len(syncIssues(app.Store.State())) == 0, "Fixture did not reproduce fully verified history without current issues: %s", encode(rt))
			assert(t, w.Code == 200, "Arming contradicted verified history: %s", w.Body)
			old := findBy(app.Store.List("orders"), "id", "old-execution")
			assert(t, !current(old) && held(old) && s(old["supersededBy"]) != "", "Archived review marker was deleted or duplicate remained current")
			total := totals(app.Store.List("orders"), app.Store.List("rewards"), "live", market)
			assert(t, n(total["spend"]) == price && n(total["earned"]) == 0 && len(app.Store.List("orders")) == 2 && len(app.Store.List("rewards")) == 1, "Archived cost/reward was counted or audit history was removed: %s", encode(total))
			assert(t, b(obj(app.Store.Get("settings"))["liveArmed"]) && !b(obj(app.Store.Get("settings"))["running"]) && len(p.posts) == 0, "Arming started or replayed a purchase")
		})
	}
}

func TestArmingIgnoresAllNoncurrentLiveOrderMarkers(t *testing.T) {
	for _, tc := range []struct {
		name, status string
		by           any
	}{{"superseded review", "SUPERSEDED", "current"}, {"archived review", "COMPLETED", "current"}, {"archived unknown", "UNKNOWN", "current"}, {"status-only superseded", "SUPERSEDED", nil}} {
		t.Run(tc.name, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			configureLive(app, false, false)
			p.shares = 1
			app.Engine.SyncNow(context.Background())
			app.Store.Save("orders", M{"id": "archived", "mode": "live", "kind": "solo", "status": tc.status, "costBtc": 410000, "supersededBy": tc.by, "attribution": M{"state": "review"}, "syncPending": M{"reason": "Historical review"}})
			cookie := login(t, app)
			w := httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
			assert(t, w.Code == 200 && b(obj(app.Store.Get("runtime"))["buyingReady"]), "Noncurrent order blocked arming: %s", w.Body)
			assert(t, !b(obj(app.Store.Get("settings"))["running"]) && len(p.posts) == 0, "Arming started buying")
		})
	}
}

func TestArmingStillBlocksCurrentPurchaseVerificationHolds(t *testing.T) {
	for _, issue := range []string{"ownership", "unknown", "pending commitment"} {
		t.Run(issue, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			configureLive(app, false, false)
			p.shares = 1
			o := M{"id": "current-hold", "mode": "live", "kind": "team", "status": "PENDING", "costBtc": 10000}
			switch issue {
			case "ownership":
				o["attribution"] = M{"state": "review", "reason": "Current ownership unverified"}
			case "unknown":
				o["status"] = "UNKNOWN"
			case "pending commitment":
				o["pendingTeamPurchase"] = M{"requestId": "uncertain", "targetCostBtc": 10000, "targetShares": 1}
			}
			app.Store.Save("orders", o)
			cookie := login(t, app)
			w := httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
			assert(t, w.Code == 400 && !b(obj(app.Store.Get("settings"))["liveArmed"]) && !b(obj(app.Store.Get("settings"))["running"]), "Current purchase hold was bypassed: %s", w.Body)
			assert(t, len(syncIssues(app.Store.State())) == 1 && len(p.posts) == 0, "Current hold disappeared or a purchase was submitted")
		})
	}
}
