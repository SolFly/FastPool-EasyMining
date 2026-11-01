package controller

import (
	"context"
	"strings"
	"testing"
	"time"
)

func setTestProfile(a *App, profile string) {
	a.Store.Set("settings", merge(obj(a.Store.Get("settings")), M{"purchaseRequestProfile": profile}))
}
func TestRequestProfilesSignedTeamSoloAndMergedPurchases(t *testing.T) {
	for _, profile := range []string{"documented", "web", "guide"} {
		for _, kind := range []string{"team", "solo", "merged"} {
			t.Run(profile+"/"+kind, func(t *testing.T) {
				a := testApp(t)
				p := newProvider(t, a)
				p.solo = kind == "solo"
				p.merged = kind == "merged"
				st := configureLive(a, true, p.solo)
				setTestProfile(a, profile)
				if p.merged {
					st["coin"] = "LTC"
					st["packageName"] = "Team Palladium"
					st["payoutAddress"] = "ltc1qbaselineexampledestination000000"
					st["mergePayoutAddress"] = "DBaselineExampleDestination000000"
					a.Store.Save("strategies", st)
				}
				a.Engine.Tick(context.Background(), false)
				p.barrier()
				assert(t, len(p.posts) == 1, "Expected exactly one submission: %s", encode(a.Store.State()))
				post := p.posts[0]
				body := obj(decode([]byte(s(post["body"]))))
				if p.solo {
					assert(t, s(post["path"]) == soloPurchasePath(profile), "Wrong solo route")
					assert(t, has(body, "buyWithCurrency") == (profile == "documented"), "Wrong solo currency field")
				} else {
					assert(t, s(post["path"]) == teamPurchasePath(profile, testTeam), "Wrong team route")
					assert(t, n(obj(body["shares"])["small"]) == 1, "Wrong shares")
					assert(t, has(body, "amount") == (profile != "guide") && has(body, "clear") == (profile != "guide"), "Guide fields were not omitted: %s", post["body"])
				}
				if p.merged {
					assert(t, s(body["soloMiningRewardWithdrawalAddrId"]) != "" && s(body["mergeSoloMiningRewardWithdrawalAddrId"]) != "", "Payout references lost")
				}
				assert(t, s(a.Store.List("orders")[0]["purchaseRequestProfile"]) == profile, "Purchase format was not retained")
			})
		}
	}
}
func TestRequestProfileChangePausesWithoutProviderCalls(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	before := obj(a.Store.Get("settings"))
	credentials := string(encode(a.Credentials()))
	cookie := login(t, a)
	w := httpCall(t, a, "POST", "/api/settings", M{"purchaseRequestProfile": "web"}, cookie, "http://localhost")
	assert(t, w.Code == 200, "Cannot change format: %s", w.Body)
	next := obj(a.Store.Get("settings"))
	assert(t, purchaseProfile(next) == "web" && !b(next["running"]) && !b(next["liveArmed"]), "Format change did not pause/disarm")
	assert(t, n(before["dailyCap"]) == n(next["dailyCap"]) && b(a.Store.Get("verified")) && credentials == string(encode(a.Credentials())), "Format change altered unrelated account state")
	p.barrier()
	assert(t, len(p.posts) == 0 && len(a.Store.List("orders")) == 0, "Saving a format submitted a purchase")
	w = httpCall(t, a, "POST", "/api/settings", M{"purchaseRequestProfile": "unknown"}, cookie, "http://localhost")
	assert(t, w.Code == 400 && purchaseProfile(obj(a.Store.Get("settings"))) == "web", "Invalid format accepted")
}
func TestRequestProfileInvalidatesUnusedManualReview(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, false, false)
	q := obj(a.Engine.Quote(context.Background(), M{"packageId": testTeam, "shares": 1}))
	setTestProfile(a, "guide")
	caught := attempt(func() { a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]}) })
	p.barrier()
	assert(t, caught != nil && strings.Contains(panicError(caught).Error(), "format changed") && len(p.posts) == 0, "Old review submitted under another format")
}
func TestRequestProfilesRejectionsAreScopedAndUnknownHoldsAreGlobal(t *testing.T) {
	o := M{"kind": "team", "packageId": testTeam, "submissionFailure": M{"rejected": true, "httpStatus": 404, "path": teamPath + testTeam, "purchaseRequestProfile": "documented"}}
	assert(t, rejectedTarget([]M{o}, testTeam, "documented") && !rejectedTarget([]M{o}, testTeam, "web") && !rejectedTarget([]M{o}, testTeam, "guide"), "Documented rejection quarantined another format")
	o["submissionFailure"] = M{"rejected": true, "httpStatus": 404, "path": teamPurchasePath("web", testTeam), "purchaseRequestProfile": "guide"}
	assert(t, rejectedTarget([]M{o}, testTeam, "guide") && !rejectedTarget([]M{o}, testTeam, "web"), "Body formats not distinguished")
	delete(obj(o["submissionFailure"]), "purchaseRequestProfile")
	assert(t, rejectedTarget([]M{o}, testTeam, "guide") && rejectedTarget([]M{o}, testTeam, "web"), "Unknown historical format did not conservatively quarantine the same route")
	a := testApp(t)
	p := newProvider(t, a)
	p.timeout = true
	configureLive(a, true, false)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	for _, profile := range []string{"web", "guide"} {
		setTestProfile(a, profile)
		a.Engine.Tick(context.Background(), true)
		p.barrier()
	}
	assert(t, len(p.posts) == 1 && s(a.Store.List("orders")[0]["status"]) == "UNKNOWN" && n(a.Store.List("orders")[0]["feeBtc"]) == 100, "Format change bypassed an uncertain reservation")
}
func TestWebProfileCumulativeAdditionAndMatchingPreflight(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	setTestProfile(a, "web")
	enableDebug(a)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	st := a.Store.List("strategies")[0]
	st["lastBuyAt"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	a.Store.Save("strategies", st)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2, "Web format did not add shares")
	body := obj(decode([]byte(s(p.posts[1]["body"]))))
	assert(t, n(obj(body["shares"])["small"]) == 2 && units(body["amount"], "amount") == 20000, "Addition is not cumulative")
	found := false
	for _, trace := range maps(purchaseDebugReport(a.Store)["traces"]) {
		for _, ev := range maps(trace["events"]) {
			d := obj(ev["details"])
			if s(ev["stage"]) == "http_request" && s(d["path"]) == "/hashpower/api/v2/hashpower/solo/shared/order/"+testTeam {
				found = true
			}
		}
	}
	assert(t, found, "Owned addition used another namespace for its preflight")
}
func TestGuideProfileBlocksUnsupportedAdditionsBeforeIntent(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	setTestProfile(a, "guide")
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	st := a.Store.List("strategies")[0]
	st["lastBuyAt"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	a.Store.Save("strategies", st)
	result := obj(a.Engine.Tick(context.Background(), false))
	p.barrier()
	assert(t, len(p.posts) == 1 && n(a.Store.List("orders")[0]["costBtc"]) == 10000, "Guide mode submitted an unsupported addition")
	assert(t, strings.Contains(s(maps(result["decisions"])[0]["reason"]), "first joins"), "Guide limitation not visible")
}
func TestGuideProfileCanSelectAnotherUnjoinedTeam(t *testing.T) {
	st := merge(defaultStrategy(), M{"id": "strategy", "mode": "team", "coin": "BCH", "packageName": "Team Silver", "teamLevels": []any{M{"threshold": 5, "shares": 1}, M{"threshold": 25, "shares": 1}}})
	p := M{"id": testTeam, "coin": "BCH", "name": "Team Silver", "team": true, "market": "BTC", "available": true, "teamShares": 68, "costBtc": 10000}
	owned := M{"id": "owned", "packageId": testTeam, "kind": "team", "strategyId": "strategy", "status": "PENDING", "costBtc": 10000, "shares": 1}
	fresh := merge(p, M{"id": "44444444-4444-4444-8444-444444444444"})
	q := pickQuote([]M{p, fresh}, st, []M{owned}, "guide")
	assert(t, s(q["id"]) == s(fresh["id"]) && s(q["parentOrderId"]) == "", "Guide format prioritized an unsupported addition over a new first join")
}
func TestPurchaseAuditUsesSelectedRequestFormat(t *testing.T) {
	for _, profile := range []string{"documented", "web", "guide"} {
		t.Run(profile, func(t *testing.T) {
			a := testApp(t)
			p := newProvider(t, a)
			configureLive(a, true, false)
			setTestProfile(a, profile)
			report := a.Engine.Audit(context.Background(), a.Connection())
			p.barrier()
			plan := maps(report["purchasePlans"])[0]
			assert(t, s(plan["route"]) == teamPurchasePath(profile, testTeam) && has(obj(plan["firstJoinBodyWithoutPayout"]), "amount") == (profile != "guide"), "Audit doesn't describe the actual selected request: %s", encode(plan))
			assert(t, len(p.posts) == 0, "Read-only audit submitted a purchase")
		})
	}
}
