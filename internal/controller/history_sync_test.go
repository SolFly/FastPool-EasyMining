package controller

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestFullHistoryUsesSelectedNamespace(t *testing.T) {
	for _, profile := range []string{"documented", "web", "guide"} {
		t.Run(profile, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			configureLive(app, true, false)
			setTestProfile(app, profile)
			p.shares = 1
			prefix := purchasePrefix(profile)
			id := "55555555-5555-4555-8555-555555555555"
			wrongReads, rewardsReads := 0, 0
			interceptProvider(app, func(r *http.Request) *http.Response {
				if profile != "documented" && strings.HasPrefix(r.URL.Path, "/main/api/v2/hashpower/") {
					wrongReads++
					return mockJSON(404, M{"errors": []M{{"code": 110, "message": "Use the selected namespace"}}})
				}
				if r.URL.Path == prefix+"/api/v2/hashpower/solo/order" {
					return mockJSON(200, M{"list": []M{{"id": id, "organizationId": testOrg, "amount": "0.0001", "currencyMarket": "BTC", "soloMiningCoin": "BTC", "status": "COMPLETED", "createdTs": stamp()}}})
				}
				if r.URL.Path == prefix+"/api/v2/hashpower/order/"+id+"/rewards" {
					rewardsReads++
					assert(t, r.Method == "GET" && r.Header.Get("X-Auth") == Sign(testCredentials, "GET", r.URL.Path, "", r.Header.Get("X-Time"), r.Header.Get("X-Nonce"), nil), "Reward read signed a different path")
					return mockJSON(200, []any{})
				}
				return nil
			})
			result := obj(app.Engine.SyncNow(context.Background()))
			p.barrier()
			assert(t, b(result["historyComplete"]) && b(result["buyingReady"]) && wrongReads == 0 && rewardsReads == 1, "History could not finish under %s: %s", profile, encode(result))
			assert(t, len(p.posts) == 0 && len(app.Store.List("orders")) == 2 && n(totals(app.Store.List("orders"), nil, "live")["spend"]) == 20000, "History sync purchased or miscounted contributions")
			rt := obj(app.Store.Get("runtime"))
			assert(t, s(rt["syncStage"]) == "ready" && !parseTime(rt["syncStartedAt"]).IsZero() && !parseTime(rt["syncFinishedAt"]).IsZero() && !parseTime(rt["lastHistoryCompleteAt"]).IsZero(), "Missing truthful completion timestamps")
		})
	}
}

func TestGlobalHistoryFailureIsVisibleAndClearsAfterRecovery(t *testing.T) {
	for _, index := range []string{"solo", "team"} {
		t.Run(index, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			configureLive(app, true, false)
			setTestProfile(app, "web")
			path := "/hashpower/api/v2/hashpower/solo/order"
			if index == "team" {
				path = "/hashpower/api/v2/hashpower/solo/shared/order"
			}
			broken := true
			suffix := strings.TrimPrefix(path, "/hashpower")
			failedPath := "/main" + suffix
			interceptProvider(app, func(r *http.Request) *http.Response {
				if broken && strings.HasSuffix(r.URL.Path, suffix) {
					return mockJSON(404, M{"errors": []M{{"code": 110, "message": "History endpoint unavailable"}}})
				}
				return nil
			})
			caught := attempt(func() { app.Engine.SyncNow(context.Background()) })
			assert(t, (caught != nil) == (index == "solo"), "Unexpected index failure behavior")
			rt := obj(diagnostics(app.Store.State(), app.Connection())["runtime"])
			assert(t, !b(rt["historyComplete"]) && !b(rt["buyingReady"]) && !parseTime(rt["syncFinishedAt"]).IsZero(), "Failed read still looks active")
			if index == "team" {
				warnings := maps(rt["syncWarnings"])
				assert(t, s(rt["syncStatus"]) == "waiting" && len(warnings) == 1 && s(warnings[0]["path"]) == failedPath && n(warnings[0]["httpStatus"]) == 404, "Global failure missing from export: %s", encode(rt))
			} else {
				assert(t, s(rt["syncStatus"]) == "retrying" && s(obj(rt["lastErrorDetails"])["path"]) == failedPath && s(rt["lastError"]) != "", "Index error missing from export: %s", encode(rt))
			}
			broken = false
			app.Engine.SyncNow(context.Background())
			rt = obj(app.Store.Get("runtime"))
			p.barrier()
			assert(t, b(rt["historyComplete"]) && b(rt["buyingReady"]) && s(rt["syncStage"]) == "ready" && len(maps(rt["syncWarnings"])) == 0 && rt["lastError"] == nil, "Successful retry left a stale hold: %s", encode(rt))
			assert(t, len(p.posts) == 0 && b(obj(app.Store.Get("settings"))["running"]) && b(obj(app.Store.Get("settings"))["liveArmed"]), "GET recovery changed authorization or purchased")
		})
	}
}

func TestRewardLinkedAcceptedTeamWaitRemainsNonblocking(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	setTestProfile(app, "web")
	app.Engine.Tick(context.Background(), false)
	st := app.Store.List("strategies")[0]
	st["lastBuyAt"] = nil
	app.Store.Save("strategies", st)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2, "Fixture needs an accepted addition")
	p.shares = 1
	execution := "55555555-5555-4555-8555-555555555555"
	interceptProvider(app, func(r *http.Request) *http.Response {
		if strings.HasSuffix(r.URL.Path, "/hashpower/solo/order") {
			return mockJSON(200, M{"list": []M{{"id": execution, "amount": "0.0068", "currencyMarket": "BTC", "soloMiningCoin": "BCH", "status": "ACTIVE"}}})
		}
		if strings.HasSuffix(r.URL.Path, "/solo/shared/order") {
			return mockJSON(200, M{"list": []any{}})
		}
		if strings.HasSuffix(r.URL.Path, "/order/"+execution+"/rewards") {
			return mockJSON(200, []M{{"id": "shared-reward-reference", "shared": true, "packageId": testTeam, "coin": "BCH"}})
		}
		if strings.HasSuffix(r.URL.Path, "/shared/order/"+testTeam) {
			raw := p.rawTeam()
			raw["orderDetails"] = M{"id": execution}
			return mockJSON(200, raw)
		}
		return nil
	})
	app.Engine.SyncNow(context.Background())
	rt := obj(app.Store.Get("runtime"))
	o := app.Store.List("orders")[0]
	assert(t, b(rt["buyingReady"]) && !b(rt["historyComplete"]) && !orderSyncBlocksBuying(o) && len(app.Store.List("orders")) == 1, "Reward-link path restored the global hold: %s", encode(app.Store.State()))
	assert(t, money(o, "costBtc") == 20000 && n(o["shares"]) == 2 && o["pendingTeamPurchase"] != nil && len(p.posts) == 2, "Recovery changed the reservation or replayed a purchase")
	assert(t, len(maps(rt["syncWarnings"])) == 2, "Fixture did not exercise both confirmation paths")
}

func TestHistoryDiagnosticWarningsExcludePrivatePayloads(t *testing.T) {
	state := M{"connection": M{"organizationId": testOrg}, "orders": []M{{"payoutAddress": "private-payout"}}, "runtime": M{"syncWarnings": []M{{"stage": "team-history", "httpStatus": 404, "path": "/hashpower/api/v2/hashpower/solo/shared/order", "reason": "private-payout " + testOrg, "privateResponse": M{"api_key": "unexported-token"}}}}}
	text := string(encode(syncDiagnostics(state)))
	assert(t, strings.Contains(text, "team-history") && strings.Contains(text, "/hashpower/") && !strings.Contains(text, testOrg) && !strings.Contains(text, "private-payout") && !strings.Contains(text, "unexported-token"), "Unsafe history diagnostics: %s", text)
}

func TestHistoryReadFallbackIsReadOnlyAndCachesSuccessfulResourceRoute(t *testing.T) {
	for _, profile := range []string{"documented", "web"} {
		t.Run(profile, func(t *testing.T) {
			api := NewNiceHash(clone(testCredentials))
			api.PurchaseProfile = profile
			primary := purchasePrefix(profile)
			alternate := "/main"
			if primary == "/main" {
				alternate = "/hashpower"
			}
			calls := []string{}
			api.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls = append(calls, r.URL.Path)
				assert(t, r.Method == "GET" && r.Header.Get("X-Auth") == Sign(testCredentials, "GET", r.URL.Path, "", r.Header.Get("X-Time"), r.Header.Get("X-Nonce"), nil), "Fallback mutated or signed another path")
				if strings.HasPrefix(r.URL.Path, primary+"/") {
					return mockJSON(404, M{"errors": []M{{"code": 110, "message": "No resource on this gateway"}}}), nil
				}
				return mockJSON(200, M{"id": r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]}), nil
			})
			one := api.Ticket(context.Background(), testTeam, true)
			twoID := "55555555-5555-4555-8555-555555555555"
			two := api.Ticket(context.Background(), twoID, true)
			assert(t, s(one["id"]) == testTeam && s(two["id"]) == twoID && len(calls) == 3 && strings.HasPrefix(calls[2], alternate+"/"), "Successful read route was not cached by resource")
			assert(t, len(api.HistoryReadFallbacks) == 1 && api.PurchaseProfile == profile && api.TeamBuyPath(testTeam) == teamPurchasePath(profile, testTeam), "Read compatibility changed the purchase format")
		})
	}
}

func TestHistoryReadFallbackNeverRetriesAuthenticationOutageOrPurchases(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		status       int
		code         any
	}{{"unauthorized", "GET", 401, 110}, {"forbidden", "GET", 403, 110}, {"outage", "GET", 503, 110}, {"other 404", "GET", 404, 999}, {"purchase", "POST", 404, 110}} {
		t.Run(tc.name, func(t *testing.T) {
			api := NewNiceHash(clone(testCredentials))
			api.PurchaseProfile = "web"
			calls := 0
			api.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				return mockJSON(tc.status, M{"errors": []M{{"code": tc.code, "message": "Rejected"}}}), nil
			})
			caught := attempt(func() {
				if tc.method == "GET" {
					api.Ticket(context.Background(), testTeam, true)
				} else {
					api.Request(context.Background(), "POST", api.TeamBuyPath(testTeam), nil, makeTeamBuyBody(M{"costBtc": 10000}, M{"shares": 1}, nil, nil), true, "purchase-request", "")
				}
			})
			assert(t, caught != nil && calls == 1 && len(api.HistoryReadFallbacks) == 0 && api.PurchaseProfile == "web", "Retried a forbidden request: %s", tc.name)
		})
	}
}
