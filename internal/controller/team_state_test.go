package controller

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func stateRejection(profile string) M {
	return M{"at": stamp(), "rejected": true, "uncertain": false, "httpStatus": 400, "code": 5251, "method": "POST", "path": teamPurchasePath(profile, testTeam), "purchaseRequestProfile": profile}
}

func TestTeamStateRejectionClassificationIsNarrow(t *testing.T) {
	for _, code := range []any{5251, "5251", json.Number("5251")} {
		for _, profile := range []string{"documented", "web", "guide"} {
			f := stateRejection(profile)
			f["code"] = code
			assert(t, teamStateRejectedFailure(f), "Lost exact rejection: %s", encode(f))
		}
	}
	for name, patch := range map[string]M{
		"uncertain": {"uncertain": true}, "not rejected": {"rejected": false},
		"server error": {"httpStatus": 500}, "authentication": {"httpStatus": 401},
		"other code": {"code": 5252}, "GET": {"method": "GET"},
		"solo": {"path": soloPurchasePath("web")}, "unknown prefix": {"path": "/other/api/v2/hashpower/shared/ticket/" + testTeam},
		"invalid ID": {"path": teamPurchasePath("web", "invalid")},
		"extra path": {"path": teamPurchasePath("web", testTeam) + "/extra"},
	} {
		t.Run(name, func(t *testing.T) {
			assert(t, !teamStateRejectedFailure(merge(stateRejection("web"), patch)), "Broadened skippable failure: %s", encode(patch))
		})
	}
}

func TestTeamStateRejectionSkipsAndMovesToNextTeam(t *testing.T) {
	for _, profile := range []string{"documented", "web", "guide"} {
		for _, levels := range []bool{false, true} {
			t.Run(profile+map[bool]string{false: "/ordinary", true: "/levels"}[levels], func(t *testing.T) {
				a := testApp(t)
				p := newProvider(t, a)
				st := configureLive(a, levels, false)
				setTestProfile(a, profile)
				p.rejectStatus, p.rejectCode = 400, 5251
				enableDebug(a)
				a.Engine.Tick(context.Background(), false)
				p.barrier()
				o := a.Store.List("orders")[0]
				assert(t, len(p.posts) == 1 && s(o["status"]) == "FAILED" && n(o["feeBtc"]) == 0 && o["pendingTeamPurchase"] == nil && o["externalId"] == nil, "Rejected intent was not released: %s", encode(o))
				settings := obj(a.Store.Get("settings"))
				rt := obj(a.Store.Get("runtime"))
				assert(t, b(settings["running"]) && b(settings["liveArmed"]) && b(a.Store.Get("verified")) && b(rt["historyComplete"]) && n(rt["errors"]) == 0, "State rejection paused/disarmed or damaged account state")
				assert(t, strings.Contains(s(maps(rt["decisions"])[0]["reason"]), "5251"), "Misleading decision")
				assert(t, s(a.Store.List("strategies")[0]["lastBuyAt"]) == s(st["lastBuyAt"]), "Rejection consumed the buying interval")
				assert(t, s(obj(obj(o["submissionFailure"])["teamCheck"])["finding"]) == "still-listed-after-rejection", "Lost post-rejection catalogue evidence")
				for _, ev := range a.Store.List("events") {
					assert(t, s(ev["level"]) != "error" && !strings.Contains(s(ev["message"]), "Engine paused"), "Unexpected global error: %s", encode(ev))
				}
				trace := maps(purchaseDebugReport(a.Store)["traces"])[0]
				assert(t, n(trace["purchasePostCount"]) == 1 && traceStages(trace)["team_after_rejection"], "State rejection was not captured")
				a.Engine.Tick(context.Background(), false)
				p.barrier()
				assert(t, len(p.posts) == 1, "Retried the same invalid-state team")
				const nextTeam = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
				p.mu.Lock()
				p.teamID, p.rejectStatus = nextTeam, 0
				p.mu.Unlock()
				a.Engine.Tick(context.Background(), false)
				p.barrier()
				assert(t, len(p.posts) == 2 && s(p.posts[1]["path"]) == teamPurchasePath(profile, nextTeam), "Did not buy the next matching team: %s", encode(a.Store.State()))
			})
		}
	}
}

func TestTeamStateRejectionContinuesOtherStrategies(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, false, false)
	setTestProfile(a, "web")
	p.rejectStatus, p.rejectCode, p.rejectPath, p.includeSolo = 400, 5251, teamPurchasePath("web", testTeam), true
	second := merge(defaultStrategy(), M{"id": "strategy-2", "name": "Other strategy", "mode": "solo", "kind": "interval", "coin": "BTC", "packageName": "Gold S", "enabled": true, "stopOnWin": false, "budget": 1000000})
	a.Store.Save("strategies", second)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2 && s(p.posts[0]["path"]) == teamPurchasePath("web", testTeam) && s(p.posts[1]["path"]) == soloPurchasePath("web"), "State rejection stopped another eligible strategy: %s", encode(a.Store.State()))
	assert(t, len(maps(obj(a.Store.Get("runtime"))["decisions"])) == 2 && b(obj(a.Store.Get("settings"))["running"]), "Other strategy was not evaluated")
}

func TestTeamStateRejectedAdditionRetainsExistingCommitment(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	setTestProfile(a, "web")
	a.Engine.Tick(context.Background(), false)
	a.Engine.SyncNow(context.Background())
	before := a.Store.List("orders")[0]
	st := a.Store.List("strategies")[0]
	st["lastBuyAt"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	a.Store.Save("strategies", st)
	p.mu.Lock()
	p.rejectStatus, p.rejectCode = 400, 5251
	p.mu.Unlock()
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	orders := a.Store.List("orders")
	o := orders[0]
	assert(t, len(orders) == 1 && n(o["costBtc"]) == n(before["costBtc"]) && n(o["shares"]) == n(before["shares"]) && s(o["externalId"]) == testTeam && o["pendingTeamPurchase"] == nil, "Lost or duplicated earlier shares: %s", encode(o))
	assert(t, string(encode(o["spendHistory"])) == string(encode(before["spendHistory"])) && purchaseCount(o) == 1 && len(maps(o["teamBuys"])) == 2, "Rejected addition changed spend/count")
	assert(t, teamStateRejectedFailure(obj(o["lastTeamPurchaseFailure"])) && b(obj(a.Store.Get("settings"))["running"]), "Addition paused or lost evidence")
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2, "Retried a rejected addition")
}

func TestTeamStateRejectionManualReviewCannotReplay(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, false, false)
	setTestProfile(a, "web")
	p.rejectStatus, p.rejectCode = 400, 5251
	q := obj(a.Engine.Quote(context.Background(), M{"packageId": testTeam, "shares": 1}))
	result := obj(a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]}))
	assert(t, s(obj(result["order"])["status"]) == "FAILED" && b(obj(a.Store.Get("settings"))["liveArmed"]), "Manual rejection disarmed live buying")
	again := obj(a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]}))
	assert(t, b(again["replayed"]) && len(p.posts) == 1, "Manual review replayed a POST")
	caught := attempt(func() { a.Engine.Quote(context.Background(), M{"packageId": testTeam, "shares": 1}) })
	assert(t, caught != nil && len(p.posts) == 1, "Allowed another review for the rejected team")
}

func TestOtherPurchaseErrorsStillPause(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		code   any
		solo   bool
	}{
		{"other 400", 400, 5252, false}, {"authentication", 401, 5251, false},
		{"permissions", 403, 5251, false}, {"uncertain server error", 500, 5251, false},
		{"solo same code", 400, 5251, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testApp(t)
			p := newProvider(t, a)
			configureLive(a, false, tc.solo)
			setTestProfile(a, "web")
			p.solo, p.rejectStatus, p.rejectCode = tc.solo, tc.status, tc.code
			a.Engine.Tick(context.Background(), false)
			p.barrier()
			assert(t, len(p.posts) == 1 && !b(obj(a.Store.Get("settings"))["running"]) && !b(obj(a.Store.Get("settings"))["liveArmed"]), "Broadened skip policy")
			if tc.status == 500 {
				o := a.Store.List("orders")[0]
				assert(t, s(o["status"]) == "UNKNOWN" && n(o["feeBtc"]) == 100, "Released an uncertain reservation")
			}
		})
	}
}

func TestHistoricalTeamStateFailureIsQuarantinedAcrossFormats(t *testing.T) {
	for _, location := range []string{"submissionFailure", "lastTeamPurchaseFailure", "teamBuys"} {
		t.Run(location, func(t *testing.T) {
			o := M{"kind": "team", "packageId": testTeam}
			failure := stateRejection("web")
			delete(failure, "purchaseRequestProfile")
			if location == "teamBuys" {
				o[location] = []M{{"failure": failure}}
			} else {
				o[location] = failure
			}
			for _, profile := range []string{"documented", "web", "guide"} {
				assert(t, rejectedTargetReason([]M{o}, testTeam, profile) == teamStateRejectedReason, "Pre-upgrade failure replayable under %s", profile)
				assert(t, !rejectedTarget([]M{o}, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", profile), "Quarantined unrelated team")
			}
		})
	}
	a := testApp(t)
	configureLive(a, false, false)
	a.Store.Set("runtime", M{"errors": 2, "historyComplete": true, "syncStatus": "ready", "lastError": "prior transport error"})
	a.Engine.RecordError(&APIError{HTTPStatus: 400, Code: 5251, Method: "POST", Path: teamPurchasePath("web", testTeam)})
	rt := obj(a.Store.Get("runtime"))
	assert(t, n(rt["errors"]) == 2 && b(rt["historyComplete"]) && s(rt["syncStatus"]) == "ready" && s(rt["lastError"]) == "prior transport error", "State skip changed the real error circuit breaker or history")
}
