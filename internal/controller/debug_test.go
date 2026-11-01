package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func enableDebug(app *App) { configurePurchaseDebug(app.Store, M{"enabled": true, "minutes": 60}) }
func traceStages(trace M) map[string]bool {
	r := map[string]bool{}
	for _, ev := range maps(trace["events"]) {
		r[s(ev["stage"])] = true
	}
	return r
}
func TestPurchaseDebugDefaultOff(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 1 && n(debugStatus(a.Store)["traceCount"]) == 0, "Disabled debugging recorded data or altered buying")
}
func TestPurchaseDebugHTTPControlsDoNotBuy(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	before := string(encode(a.Store.State()))
	for _, tc := range []struct {
		method, path string
		body         M
	}{{"GET", "/api/debug", nil}, {"POST", "/api/debug", M{"enabled": true}}, {"DELETE", "/api/debug/traces", M{}}} {
		w := httpCall(t, a, tc.method, tc.path, tc.body, nil, "http://localhost")
		assert(t, w.Code == 401, "Debug endpoint lacks authentication")
	}
	cookie := login(t, a)
	w := httpCall(t, a, "POST", "/api/debug", M{"enabled": true}, cookie, "https://evil.example")
	assert(t, w.Code == 403, "Cross-origin debug configuration accepted")
	w = httpCall(t, a, "POST", "/api/debug", M{"enabled": true, "minutes": 60}, cookie, "http://localhost")
	assert(t, w.Code == 200, "Cannot enable debugging: %s", w.Body)
	assert(t, b(obj(decode(w.Body.Bytes()))["enabled"]), "Capture did not enable")
	for _, minutes := range []any{-1, 0, 1, 241, "60"} {
		w = httpCall(t, a, "POST", "/api/debug", M{"enabled": true, "minutes": minutes}, cookie, "http://localhost")
		assert(t, w.Code == 400, "Invalid duration accepted")
	}
	w = httpCall(t, a, "GET", "/api/debug", nil, cookie, "")
	assert(t, w.Code == 200 && len(maps(obj(decode(w.Body.Bytes()))["traces"])) == 0, "Read changed debug history")
	w = httpCall(t, a, "DELETE", "/api/debug/traces", M{}, cookie, "https://evil.example")
	assert(t, w.Code == 403, "Cross-origin debug clear accepted")
	w = httpCall(t, a, "DELETE", "/api/debug/traces", M{}, cookie, "http://localhost")
	assert(t, w.Code == 200, "Cannot clear debugging")
	w = httpCall(t, a, "POST", "/api/debug", M{"enabled": false}, cookie, "http://localhost")
	assert(t, w.Code == 200 && !b(debugStatus(a.Store)["enabled"]), "Cannot stop capture")
	p.barrier()
	assert(t, len(p.posts) == 0 && string(encode(a.Store.State())) == before, "Debug controls bought, armed, paused, synced or changed configuration")
}
func TestPurchaseDebugCapturesRejectionAndPayoutCorrelation(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	p.merged = true
	p.reject = true
	st := configureLive(a, true, false)
	st["coin"] = "LTC"
	st["packageName"] = "Team Palladium"
	st["payoutAddress"] = "ltc1qbaselineexampledestination000000"
	st["mergePayoutAddress"] = "DBaselineExampleDestination000000"
	a.Store.Save("strategies", st)
	enableDebug(a)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	report := purchaseDebugReport(a.Store)
	traces := maps(report["traces"])
	assert(t, len(traces) == 1, "Missing debug trace")
	trace := traces[0]
	assert(t, s(trace["outcome"]) == "rejected" && n(trace["purchasePostCount"]) == 1, "Rejection not traced")
	for _, stage := range []string{"evaluation_started", "catalogue_ready", "strategy_decision", "payout_resolved", "final_guard", "intent_persisted", "http_request", "http_response", "team_after_rejection", "purchase_result", "evaluation_finished"} {
		assert(t, traceStages(trace)[stage], "Missing stage %s", stage)
	}
	text := string(encode(report))
	for _, secret := range []string{"fixture-key", "fixture-secret", testOrg, "ltc1qbaselineexampledestination000000", "DBaselineExampleDestination000000", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "X-Auth", "X-Twofa-Token"} {
		assert(t, !strings.Contains(text, secret), "Debug leaked %s", secret)
	}
	matched := false
	found404 := false
	for _, ev := range maps(trace["events"]) {
		d := obj(ev["details"])
		if s(ev["stage"]) == "http_request" && s(d["method"]) == "POST" {
			body := obj(d["body"])
			assert(t, f(body["amount"]) == 0.0001 && n(obj(body["shares"])["small"]) == 1, "Wrong captured payload")
			matched = s(obj(body["soloMiningRewardWithdrawalAddrId"])["fingerprint"]) == s(debugFingerprint("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
			digest := sha256.Sum256([]byte(s(p.posts[0]["body"])))
			assert(t, s(d["bodySHA256"]) == hex.EncodeToString(digest[:]), "Request fingerprint is not the exact transmitted body")
		}
		if s(ev["stage"]) == "http_response" && n(d["httpStatus"]) == 404 {
			found404 = true
			assert(t, s(maps(obj(d["summary"])["errors"])[0]["code"]) == "110", "Provider code missing")
		}
	}
	assert(t, matched && found404, "Missing payout correlation or rejection response")
	assert(t, s(a.Store.List("orders")[0]["debugTraceId"]) == s(trace["id"]), "Order not correlated")
	a.Engine.Tick(context.Background(), true)
	p.barrier()
	assert(t, len(p.posts) == 1, "Debugging retried a quarantined purchase")
}
func TestPurchaseDebugCapturesSkippedThreshold(t *testing.T) {
	a := testApp(t)
	newProvider(t, a)
	st := configureLive(a, true, false)
	st["teamLevels"] = []any{M{"threshold": 100, "shares": 1}}
	a.Store.Save("strategies", st)
	enableDebug(a)
	a.Engine.Tick(context.Background(), false)
	trace := maps(purchaseDebugReport(a.Store)["traces"])[0]
	assert(t, s(trace["outcome"]) == "no-purchase" && n(trace["purchasePostCount"]) == 0, "Skipped strategy submitted")
	assert(t, strings.Contains(string(encode(trace)), "Waiting for 100 joined team shares"), "Skip reason missing")
}
func TestPurchaseDebugRetainsUnknownReservation(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	p.timeout = true
	configureLive(a, true, false)
	enableDebug(a)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	o := a.Store.List("orders")[0]
	trace := maps(purchaseDebugReport(a.Store)["traces"])[0]
	assert(t, s(o["status"]) == "UNKNOWN" && n(o["feeBtc"]) == 100 && o["pendingTeamPurchase"] != nil, "Debug changed unknown reservation")
	assert(t, s(trace["outcome"]) == "uncertain" && n(trace["purchasePostCount"]) == 1, "Unknown submission not traced")
}
func TestPurchaseDebugWriteFailureDoesNotAffectBuying(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	enableDebug(a)
	a.Store.Exec("CREATE TRIGGER reject_debug_write BEFORE INSERT ON purchase_debug BEGIN SELECT RAISE(FAIL,'debug disk failure'); END")
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 1 && s(a.Store.List("orders")[0]["status"]) == "PENDING", "Debug storage error changed purchase outcome")
}
func TestPurchaseDebugRetentionExpiryAndRestart(t *testing.T) {
	dir := t.TempDir()
	st := OpenStore(dir)
	configurePurchaseDebug(st, M{"enabled": true, "minutes": 15})
	for i := 0; i < 55; i++ {
		tr := &purchaseDebugTrace{store: st, id: uuid(), startedAt: time.Now().Add(time.Duration(i) * time.Millisecond).UTC().Format(time.RFC3339Nano), started: time.Now(), events: []M{}, outcome: "running"}
		for j := 0; j < debugEventLimit+3; j++ {
			tr.add("stage", M{})
		}
		tr.save()
	}
	report := purchaseDebugReport(st)
	assert(t, len(maps(report["traces"])) == 50, "Trace retention not bounded")
	assert(t, len(maps(maps(report["traces"])[0]["events"])) == debugEventLimit && n(maps(report["traces"])[0]["droppedEvents"]) == 3, "Event retention not bounded")
	st.Set("purchaseDebug", M{"enabled": true, "expiresAt": time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)})
	assert(t, !b(debugStatus(st)["enabled"]), "Expired debugging still active")
	st.Close()
	st = OpenStore(dir)
	defer st.Close()
	assert(t, len(maps(purchaseDebugReport(st)["traces"])) == 50 && s(maps(purchaseDebugReport(st)["traces"])[0]["outcome"]) == "interrupted", "Restart lost or mislabels unfinished traces")
}
func TestPurchaseDebugPersistsBeforeNetworkAndWhitelistsResponse(t *testing.T) {
	a := testApp(t)
	enableDebug(a)
	ctx, finish := a.Engine.beginPurchaseDebug(context.Background(), "test")
	defer finish()
	tr := debugTrace(ctx)
	tr.network = true
	api := NewNiceHash(testCredentials)
	auth := ""
	api.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		auth = r.Header.Get("X-Auth")
		captured := maps(purchaseDebugReport(a.Store)["traces"])
		assert(t, len(captured) == 1 && s(captured[0]["outcome"]) == "running" && n(captured[0]["purchasePostCount"]) == 1, "Request trace not saved before network")
		body := `{"error_id":"12345678-1234-4234-8234-123456789012","errors":[{"code":110,"message":"fixture-key fixture-secret ` + testOrg + ` bchtest1exampleaddress000000000000 123456"}],"password":"private-password","balance":"99.999","address":"secret-address"}`
		return &http.Response{StatusCode: 404, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	_ = attempt(func() {
		api.Request(ctx, "POST", teamPath+testTeam, nil, makeTeamBuyBody(M{"costBtc": 10000}, M{"shares": 1}, nil, nil), true, uuid(), "123456")
	})
	text := string(encode(purchaseDebugReport(a.Store)))
	for _, secret := range []string{auth, "fixture-key", "fixture-secret", testOrg, "bchtest1exampleaddress000000000000", "123456\"", "private-password", "99.999", "secret-address"} {
		assert(t, !strings.Contains(text, secret), "Debug leaked response data %s", secret)
	}
	assert(t, strings.Contains(text, "12345678-1234-4234-8234-123456789012"), "Provider trace reference removed")
}
func TestPurchaseDebugManualReviewCannotReplay(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, false, false)
	enableDebug(a)
	q := obj(a.Engine.Quote(context.Background(), M{"packageId": testTeam, "shares": 1}))
	a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]})
	a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]})
	p.barrier()
	assert(t, len(p.posts) == 1 && len(maps(purchaseDebugReport(a.Store)["traces"])) == 2, "Debugging replayed manual review")
}
func TestPurchaseDebugAdditionHasCumulativeRequest(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	st := configureLive(a, true, false)
	enableDebug(a)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	st = obj(a.Store.List("strategies")[0])
	st["lastBuyAt"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	a.Store.Save("strategies", st)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2, "Expected two normal level submissions")
	traces := maps(purchaseDebugReport(a.Store)["traces"])
	found := false
	for _, tr := range traces {
		for _, ev := range maps(tr["events"]) {
			if s(ev["stage"]) == "owned_addition_verified" {
				found = true
				assert(t, n(obj(ev["details"])["targetShares"]) == 2 && n(obj(ev["details"])["targetCostBtc"]) == 20000, "Cumulative preflight omitted")
			}
		}
	}
	assert(t, found, "Addition preflight not captured: %s", fmt.Sprint(len(traces)))
}

func TestPurchaseDebugRejectedAdditionKeepsEarlierSharesAndTraceLink(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureLive(a, true, false)
	enableDebug(a)
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	firstOrder := a.Store.List("orders")[0]
	st := a.Store.List("strategies")[0]
	st["lastBuyAt"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	a.Store.Save("strategies", st)
	p.mu.Lock()
	p.reject = true
	p.mu.Unlock()
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	o := a.Store.List("orders")[0]
	traces := maps(purchaseDebugReport(a.Store)["traces"])
	var rejected M
	for _, trace := range traces {
		if s(trace["outcome"]) == "rejected-addition-prior-holding-retained" {
			rejected = trace
		}
	}
	assert(t, rejected != nil && len(p.posts) == 2, "Rejected addition was mislabeled")
	assert(t, n(o["costBtc"]) == 10000 && n(o["shares"]) == 1 && s(o["id"]) == s(firstOrder["id"]), "Earlier commitment changed")
	assert(t, s(o["debugTraceId"]) == s(rejected["id"]) && s(obj(o["lastTeamPurchaseFailure"])["debugTraceId"]) == s(rejected["id"]), "Failure linked to the wrong capture")
}
