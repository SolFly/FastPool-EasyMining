package controller

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func mockJSON(code int, data any) *http.Response {
	return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(encode(data))))}
}

func interceptProvider(app *App, intercept func(*http.Request) *http.Response) {
	original := app.Engine.APIOverride
	app.Engine.APIOverride = func(c M) *NiceHash {
		api := original(c)
		transport := api.HTTP.Transport
		api.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if response := intercept(r); response != nil {
				return response, nil
			}
			return transport.RoundTrip(r)
		})
		return api
	}
	app.Engine.api = nil
}

func TestHistoryDetailsUseSelectedNamespace(t *testing.T) {
	for _, profile := range []string{"documented", "web", "guide"} {
		t.Run(profile, func(t *testing.T) {
			api := NewNiceHash(clone(testCredentials))
			api.PurchaseProfile = profile
			paths := []string{}
			api.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				assert(t, r.Method == "GET" && strings.HasPrefix(r.URL.Path, purchasePrefix(profile)+"/api/v2/hashpower/"), "Wrong read namespace: %s %s", r.Method, r.URL.Path)
				paths = append(paths, r.URL.Path)
				assert(t, r.Header.Get("X-Auth") == Sign(testCredentials, "GET", r.URL.Path, "", r.Header.Get("X-Time"), r.Header.Get("X-Nonce"), nil), "Read signature used another namespace")
				return mockJSON(200, M{"id": testTeam}), nil
			})
			api.Ticket(context.Background(), testTeam, true)
			api.Ticket(context.Background(), testTeam, false)
			assert(t, len(paths) == 2, "A detail read retried or posted")
		})
	}
}

func TestSixHourAcceptedTeamWaitDoesNotHoldOtherStrategies(t *testing.T) {
	for _, market := range []string{"BTC", "USDT"} {
		t.Run(market, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			st := configureLive(app, true, false)
			if market == "USDT" {
				st = configureUSDT(app, p, true, false)
			}
			setTestProfile(app, "web")
			app.Engine.Tick(context.Background(), false)
			p.barrier()
			assert(t, len(p.posts) == 1, "Fixture did not buy")
			o := app.Store.List("orders")[0]
			old := time.Now().Add(-6 * time.Hour).UTC().Format(time.RFC3339Nano)
			obj(o["syncPending"])["since"] = old
			app.Store.Save("orders", o)
			p.shares = 0 // private membership is delayed after the acknowledged POST
			missing := true
			interceptProvider(app, func(r *http.Request) *http.Response {
				if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/hashpower/solo/order") && len(p.posts) >= 2 {
					amount, coin := "0.0001", "BTC"
					if market == "USDT" {
						amount, coin = "5", "BCH"
					}
					return mockJSON(200, M{"list": []M{{"id": "55555555-5555-4555-8555-555555555555", "organizationId": testOrg, "amount": amount, "currencyMarket": market, "soloMiningCoin": coin, "status": "PENDING", "soloReward": []any{}}}})
				}
				if missing && r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/shared/order/"+testTeam) {
					return mockJSON(404, M{"errors": []M{{"code": 110, "message": "Order details unavailable"}}})
				}
				return nil
			})
			p.includeSolo = true
			solo := merge(defaultStrategy(), M{"id": "another-strategy", "name": "Independent strategy", "enabled": true, "continuous": true, "market": market, "mode": "solo", "coin": "BTC", "packageName": "Gold S", "maxPrice": 10000, "intervalMinutes": 60})
			if market == "USDT" {
				solo["coin"], solo["packageName"], solo["maxPrice"] = "BCH", "Silver 5", 5*Sat
			}
			app.Store.Save("strategies", solo)
			app.Engine.Tick(context.Background(), false)
			p.barrier()
			assert(t, len(p.posts) == 2 && strings.HasSuffix(s(p.posts[1]["path"]), "/solo/order"), "Accepted team held another strategy: %s", encode(app.Store.State()))
			o = findBy(app.Store.List("orders"), "id", o["id"])
			assert(t, !orderSyncBlocksBuying(o) && o["pendingTeamPurchase"] != nil && purchaseCount(o) == 1 && s(obj(o["syncPending"])["since"]) == old, "Lost accepted reservation or retry age: %s", encode(o))
			rt := obj(app.Store.Get("runtime"))
			assert(t, b(rt["buyingReady"]) && !b(rt["historyComplete"]) && b(obj(app.Store.Get("settings"))["running"]) && b(obj(app.Store.Get("settings"))["liveArmed"]), "Refresh paused or disarmed buying")
			app.Engine.SyncNow(context.Background())
			p.barrier()
			assert(t, len(p.posts) == 2, "Manual sync replayed a POST")
			missing, p.shares = false, 1
			app.Engine.SyncNow(context.Background())
			o = findBy(app.Store.List("orders"), "id", o["id"])
			assert(t, o["pendingTeamPurchase"] == nil && o["syncPending"] == nil && s(maps(o["teamBuys"])[0]["status"]) == "CONFIRMED", "Membership recovery failed: %s", encode(o))
			st["lastBuyAt"] = nil
			app.Store.Save("strategies", st)
			app.Engine.Tick(context.Background(), false)
			p.barrier()
			assert(t, len(p.posts) == 3, "Next verified team level could not buy")
			body := obj(decode([]byte(s(p.posts[2]["body"]))))
			assert(t, n(obj(body["shares"])["small"]) == 2, "Next level was not cumulative")
			assert(t, s(p.posts[0]["requestId"]) != s(p.posts[2]["requestId"]), "Next level replayed an earlier request")
		})
	}
}

func TestAcceptedMembershipLagRepairsOnlyAcknowledgedLegacyWait(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	o := app.Store.List("orders")[0]
	o["status"], o["error"] = "UNKNOWN", "Waiting for NiceHash to verify the full team level commitment"
	o["syncPending"] = M{"since": "2026-10-31T10:00:00Z", "reason": o["error"]}
	app.Store.Save("orders", o)
	p.shares = 0
	// A real private detail returns no membership yet, rather than an HTTP error.
	app.Engine.SyncNow(context.Background())
	o = app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "PENDING" && !orderSyncBlocksBuying(o) && b(obj(app.Store.Get("runtime"))["buyingReady"]), "Acknowledged legacy wait was not repaired: %s", encode(o))
	assert(t, len(p.posts) == 1 && money(o, "costBtc") == 10000, "Repair replayed or discarded the purchase")
	app.Engine.Pause("Restart simulation")
	cookie := login(t, app)
	w := httpCall(t, app, "POST", "/api/arm", M{"password": "test-password-123", "confirm": "ENABLE LIVE BUYING"}, cookie, "http://localhost")
	assert(t, w.Code == 200 && b(obj(app.Store.Get("settings"))["liveArmed"]) && !b(obj(app.Store.Get("settings"))["running"]), "Accepted detail wait prevented arming or auto-started buying: %s", w.Body)
	assert(t, len(p.posts) == 1, "Arming replayed the purchase")
	entry := maps(o["teamBuys"])[0]
	entry["status"], entry["failure"] = "UNKNOWN", M{"uncertain": true}
	o["teamBuys"] = []M{entry}
	o["status"], o["error"] = "UNKNOWN", "Waiting for NiceHash to verify the full team level commitment"
	app.Store.Save("orders", o)
	app.Engine.SyncNow(context.Background())
	assert(t, s(app.Store.List("orders")[0]["status"]) == "UNKNOWN" && !b(obj(app.Store.Get("runtime"))["buyingReady"]), "Uncertain POST was treated as an acknowledgement")
}

func TestAcceptedContributionLagPreservesTargetAndRepairsOldShareCount(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	st := configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	st = app.Store.List("strategies")[0]
	st["lastBuyAt"] = nil
	app.Store.Save("strategies", st)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2, "Fixture did not buy an addition")
	p.shares = 1 // the first accepted contribution, before the second is reflected
	app.Engine.SyncNow(context.Background())
	o := app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "PENDING" && n(o["shares"]) == 2 && money(o, "costBtc") == 20000 && !orderSyncBlocksBuying(o) && b(obj(app.Store.Get("runtime"))["buyingReady"]), "Lag discarded the accepted target: %s", encode(o))
	o["status"], o["error"], o["shares"] = "UNKNOWN", "Waiting for NiceHash to verify the full team level commitment", 1
	app.Store.Save("orders", o)
	app.Engine.SyncNow(context.Background())
	o = app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "PENDING" && n(o["shares"]) == 2 && money(o, "costBtc") == 20000 && o["pendingTeamPurchase"] != nil && !orderSyncBlocksBuying(o), "Legacy member-share lag was not repaired: %s", encode(o))
	assert(t, len(p.posts) == 2, "Sync retried the accepted addition")
}

func TestVerifiedPrivateTeamIndexKeepsSpendCapsAndRewards(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	st := configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	o := app.Store.List("orders")[0]
	app.Engine.SyncNow(context.Background())
	app.Store.Save("rewards", M{"id": "personal-reward", "orderId": o["id"], "teamId": testTeam, "coin": "BCH", "amount": 1234, "confirmed": true, "valueBtc": 5, "createdAt": stamp()})
	p.shares = 3 // two extra shares bought directly on NiceHash
	interceptProvider(app, func(r *http.Request) *http.Response {
		if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/shared/order/"+testTeam) {
			return mockJSON(503, M{"errors": []M{{"message": "Temporary detail outage"}}})
		}
		return nil
	})
	settings := obj(app.Store.Get("settings"))
	settings["dailyCap"] = 35000
	app.Store.Set("settings", settings)
	st["lastBuyAt"] = nil
	app.Store.Save("strategies", st)
	p.includeSolo = true
	app.Store.Save("strategies", merge(defaultStrategy(), M{"id": "cap-check", "enabled": true, "mode": "solo", "coin": "BTC", "packageName": "Gold S"}))
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	o = findBy(app.Store.List("orders"), "id", o["id"])
	assert(t, money(o, "costBtc") == 30000 && !orderSyncBlocksBuying(o) && b(obj(app.Store.Get("runtime"))["buyingReady"]), "Private index did not retain personal spend: %s", encode(o))
	decision := findBy(maps(obj(app.Store.Get("runtime"))["decisions"]), "id", "cap-check")
	assert(t, len(p.posts) == 1 && s(decision["reason"]) == "Daily spending cap", "New spend bypassed the cap: %s", encode(decision))
	rewards := app.Store.List("rewards")
	assert(t, len(rewards) == 1 && n(rewards[0]["amount"]) == 1234 && b(rewards[0]["confirmed"]), "Funding-only sync altered rewards")
}

func TestSyncHoldEvidenceCannotBeForgedByFlagOrAge(t *testing.T) {
	for _, tc := range []string{"lost POST", "flag only", "wrong amount", "wrong market", "returned payment", "wrong organization", "authentication"} {
		t.Run(tc, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			configureLive(app, true, false)
			if tc == "lost POST" {
				p.timeout = true
			}
			app.Engine.Tick(context.Background(), false)
			p.barrier()
			o := app.Store.List("orders")[0]
			if tc == "flag only" {
				o["purchaseReceipts"], o["teamBuys"] = nil, nil
				o["syncPending"] = M{"blocking": false, "since": "2020-01-01T00:00:00Z"}
				assert(t, orderSyncBlocksBuying(o), "A flag/age alone released buying")
				return
			}
			if tc == "wrong amount" {
				setMoney(o, "costBtc", 20000)
				app.Store.Save("orders", o)
				assert(t, !acceptedTeamCommitment(o), "Acknowledgement covered a different total")
			}
			interceptProvider(app, func(r *http.Request) *http.Response {
				if r.Method != "GET" {
					return nil
				}
				if strings.HasSuffix(r.URL.Path, "/shared/order/"+testTeam) {
					code := 404
					if tc == "authentication" {
						code = 401
					}
					return mockJSON(code, M{"errors": []M{{"code": 110, "message": "Unavailable"}}})
				}
				if strings.HasSuffix(r.URL.Path, "/shared/order") {
					raw := p.rawTeam()
					switch tc {
					case "lost POST", "wrong amount":
						raw["members"] = []any{}
					case "wrong market":
						obj(raw["currencyAlgoTicket"])["currencyMarket"] = "USDT"
					case "returned payment":
						maps(raw["members"])[0]["paymentStatus"] = "RETURNED"
					case "wrong organization":
						maps(raw["members"])[0]["organizationId"] = "another-organization"
						// Remove accepted proof: this is a newly discovered unowned index row.
						o["purchaseReceipts"], o["teamBuys"] = nil, nil
						app.Store.Save("orders", o)
					}
					return mockJSON(200, M{"list": []M{raw}})
				}
				return nil
			})
			attempt(func() { app.Engine.SyncNow(context.Background()) })
			assert(t, !b(obj(app.Store.Get("runtime"))["buyingReady"]), "Unsafe case released buying: %s", encode(app.Store.State()))
			assert(t, len(p.posts) == 1, "Read retry submitted another purchase")
			if tc == "authentication" {
				assert(t, !b(obj(app.Store.Get("settings"))["liveArmed"]), "Authentication error did not disarm")
			}
		})
	}
}

func TestSyncDiagnosticsExposeHoldsWithoutPrivateFields(t *testing.T) {
	app := testApp(t)
	o := M{"id": "local", "mode": "live", "kind": "team", "name": "Held team", "status": "PENDING", "costBtc": 10000, "feeBtc": 100, "createdAt": "2026-10-31T10:00:00Z", "payoutAddress": "private-payout", "syncPending": M{"since": "2026-10-31T11:00:00Z", "reason": "Delayed private-payout", "httpStatus": 404, "path": "/hashpower/api/v2/hashpower/solo/shared/order/" + testTeam, "requestId": "get-request"}}
	app.Store.Save("orders", o)
	d := diagnostics(app.Store.State(), app.Connection())
	text := string(encode(d))
	issues := maps(d["syncIssues"])
	assert(t, len(issues) == 1 && b(issues[0]["blocking"]) && n(issues[0]["reservedAmount"]) == 10100 && s(issues[0]["since"]) == "2026-10-31T11:00:00Z" && n(issues[0]["httpStatus"]) == 404, "Hold evidence missing: %s", text)
	assert(t, !strings.Contains(text, "private-payout") && !strings.Contains(text, s(testCredentials["key"])) && !strings.Contains(text, testOrg), "Diagnostics leaked private values")
}
