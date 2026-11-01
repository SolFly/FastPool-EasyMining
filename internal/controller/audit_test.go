package controller

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func capturedPublic(t *testing.T) M {
	t.Helper()
	data, err := os.ReadFile("testdata/nicehash-public-2026-10-28.json")
	must(err)
	return obj(decode(data))
}
func TestCapturedNiceHashCatalogueStatistics(t *testing.T) {
	fixture := capturedPublic(t)
	for _, raw := range maps(fixture["teams"]) {
		t.Run(s(obj(raw["currencyAlgoTicket"])["name"]), func(t *testing.T) {
			q := normalizePackage(raw, stamp(), true)
			assert(t, s(q["id"]) == s(raw["id"]) && s(q["id"]) != s(obj(raw["currencyAlgoTicket"])["id"]), "Template ID replaced team ID")
			assert(t, n(q["duration"]) == n(raw["duration"]), "Team used template duration rather than actual duration")
			assert(t, n(q["teamShares"]) == units(raw["addedAmount"], "committed")/units(raw["minShareAmount"], "minimum"), "Share count differs from contribution / price")
			if s(q["market"]) == "BTC" {
				assert(t, n(q["costBtc"]) == 10000, "Unexpected BTC share price")
			} else {
				assert(t, q["costBtc"] == nil, "USDT became BTC ledger spend")
			}
			for _, block := range maps(q["blockRewards"]) {
				assert(t, contains([]string{"BTC", "BCH", "LTC", "DOGE", "ZEC"}, s(block["coin"])), "Wrong reward coin")
			}
		})
	}
	for _, raw := range maps(fixture["solo"]) {
		q := normalizePackage(raw, stamp(), false)
		assert(t, n(q["costBtc"]) == units(raw["price"], "solo price") && n(q["duration"]) == n(raw["duration"]), "Solo price or duration changed")
	}
	rates := normalizeRates(obj(fixture["rates"]))
	for _, coin := range []string{"BTC", "BCH", "LTC", "DOGE", "ZEC"} {
		for _, fiat := range []string{"USD", "EUR"} {
			assert(t, f(fiatValue(Sat, coin, fiat, rates)) > 0, "No actual captured conversion for %s/%s", coin, fiat)
		}
	}
}
func TestReportedSilverFirstLevelHasOriginalBody(t *testing.T) {
	fixture := capturedPublic(t)
	raw := findBy(maps(fixture["teams"]), "id", "f9255b2f-a6fd-43d7-b82e-3502b037bf94")
	assert(t, raw != nil, "Reported failing ID absent from captured catalogue")
	q := normalizePackage(raw, stamp(), true)
	st := merge(defaultStrategy(), M{"id": "silver", "mode": "team", "kind": "team", "coin": "BCH", "packageName": "Team Silver", "enabled": true, "shares": 1, "teamLevels": []any{M{"threshold": 5, "shares": 1}, M{"threshold": 25, "shares": 1}, M{"threshold": 35, "shares": 1}}})
	selected := pickQuote([]M{q}, st, nil)
	assert(t, selected != nil && n(selected["teamShares"]) == 6 && n(obj(selected["teamLevel"])["threshold"]) == 5, "Wrong first level for real catalogue")
	levelBody := makeTeamBuyBody(selected, merge(st, M{"shares": selected["shares"]}), nil, nil)
	ordinaryBody := makeTeamBuyBody(q, merge(st, M{"teamLevels": []any{}}), nil, nil)
	assert(t, string(encode(levelBody)) == `{"amount":0.0001,"shares":{"small":1},"clear":false}` && string(encode(levelBody)) == string(encode(ordinaryBody)), "First level request differs from original join: %s", encode(levelBody))
	assert(t, teamPath+s(selected["id"]) == "/main/api/v2/hashpower/shared/ticket/f9255b2f-a6fd-43d7-b82e-3502b037bf94", "Wrong endpoint target")
}
func TestAuditUsesGETOnlyAndRetainsAuthority(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	before := string(encode(app.Store.Get("settings")))
	beforeStrategies := string(encode(app.Store.List("strategies")))
	result := app.Engine.Audit(context.Background(), app.Connection())
	p.barrier()
	assert(t, len(p.posts) == 0 && len(app.Store.List("orders")) == 0, "Audit submitted purchase or created intent")
	assert(t, b(result["readOnly"]) && len(maps(result["probes"])) >= 10, "Missing probes")
	for _, row := range maps(result["probes"]) {
		assert(t, s(row["method"]) == "GET", "Audit called provider mutation")
	}
	assert(t, string(encode(app.Store.Get("settings"))) == before && string(encode(app.Store.List("strategies"))) == beforeStrategies, "Audit altered buying authority")
	text := string(encode(result))
	for _, secret := range []string{"fixture-key", "fixture-secret", testOrg, "ltc1qbaselineexampledestination000000", "DBaselineExampleDestination000000"} {
		assert(t, !strings.Contains(text, secret), "Audit leaked %s", secret)
	}
	plans := maps(result["purchasePlans"])
	assert(t, len(plans) == 1 && s(plans[0]["selectedTeamId"]) == testTeam && plans[0]["firstJoinBodyWithoutPayout"] != nil, "Missing reviewed purchase plan")
}
func TestHTTPAuditRequiresAuthenticationAndOrigin(t *testing.T) {
	app := testApp(t)
	newProvider(t, app)
	configureLive(app, false, false)
	w := httpCall(t, app, "POST", "/api/audit", M{}, nil, "http://localhost")
	assert(t, w.Code == 401, "Unauthenticated API audit allowed")
	cookie := login(t, app)
	w = httpCall(t, app, "POST", "/api/audit", M{}, cookie, "https://evil.example")
	assert(t, w.Code == 403, "Cross-origin audit allowed")
	w = httpCall(t, app, "POST", "/api/audit", M{}, cookie, "http://localhost")
	assert(t, w.Code == 200 && b(obj(decode(w.Body.Bytes()))["readOnly"]), "Audit endpoint failed: %s", w.Body)
}
func TestProviderErrorReferenceIsRetained(t *testing.T) {
	api := NewNiceHash(testCredentials)
	api.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(`{"error_id":"12345678-1234-4234-8234-123456789012","errors":[{"code":110,"message":"The requested resource was not found"}]}`)), Header: http.Header{}}, nil
	})}
	caught := attempt(func() {
		api.Request(context.Background(), "POST", teamPath+testTeam, nil, makeTeamBuyBody(M{"costBtc": 10000}, M{"shares": 1}, nil, nil), true, "request", "")
	})
	err, ok := caught.(*APIError)
	assert(t, ok && err.ProviderErrorID == "12345678-1234-4234-8234-123456789012" && err.HTTPStatus == 404, "Provider error_id missing")
}
func TestPaperLevelJournalMatchesCommitmentAfterBufferRelease(t *testing.T) {
	app := testApp(t)
	newProvider(t, app)
	st := configureLive(app, true, false)
	settings := obj(app.Store.Get("settings"))
	settings["mode"] = "paper"
	settings["paperBalance"] = 2000000
	app.Store.Set("settings", settings)
	app.Engine.Tick(context.Background(), false)
	st = app.Store.List("strategies")[0]
	st["lastBuyAt"] = nil
	app.Store.Save("strategies", st)
	app.Engine.Tick(context.Background(), false)
	o := app.Store.List("orders")[0]
	sum := int64(0)
	for _, entry := range maps(o["spendHistory"]) {
		sum += n(entry["amountBtc"])
	}
	assert(t, n(o["costBtc"]) == 20000 && n(o["feeBtc"]) == 0 && sum == 20000 && len(spendEntries(o)) > 1, "Paper additions fell back to original purchase day: %s", encode(o))
	issues := maps(obj(ledgerAudit(app.Store.State()))["issues"])
	assert(t, len(issues) == 0, "New paper journal has audit mismatch: %s", encode(issues))
}
func TestExcludedRewardsDoNotInflateAnyGoFinancialReport(t *testing.T) {
	orders := []M{{"id": "o", "mode": "live", "kind": "solo", "status": "COMPLETED", "costBtc": 10000, "createdAt": stamp()}}
	rewards := []M{{"id": "valid", "orderId": "o", "coin": "BTC", "amount": 20000, "valueBtc": 20000, "confirmed": true, "createdAt": stamp()}, {"id": "orphan", "orderId": "o", "coin": "BTC", "amount": 3 * Sat, "valueBtc": 3 * Sat, "confirmed": true, "confirmations": -1, "createdAt": stamp()}, {"id": "donated", "orderId": "o", "coin": "BCH", "amount": 5 * Sat, "valueBtc": 900000, "confirmed": false, "depositDonated": true, "createdAt": stamp()}}
	sum := totals(orders, rewards, "live")
	assert(t, n(sum["earned"]) == 20000 && n(sum["pending"]) == 0 && n(sum["net"]) == 10000, "Excluded rewards inflated P&L")
	report := dailyReport(orders, rewards, "live", "Europe/Sofia", 7, time.Now(), nil)
	assert(t, n(obj(report["total"])["earned"]) == 20000 && n(obj(report["total"])["pending"]) == 0, "Daily report credited excluded rewards")
	state := M{"settings": merge(defaultSettings(), M{"mode": "live"}), "orders": orders, "rewards": rewards}
	audit := ledgerAudit(state)
	btc := obj(obj(audit["coinQuantities"])["BTC"])
	assert(t, n(btc["confirmedUnits"]) == 20000 && n(btc["excludedUnits"]) == 3*Sat, "Coin audit lost orphan quantity reference")
	csv := ledgerCSV(state, "live")
	assert(t, !strings.Contains(csv, "orphan") && !strings.Contains(csv, "donated"), "Financial CSV includes excluded rewards")
}
func TestSoloProviderFlagsPersistWithoutDiscardingEvidence(t *testing.T) {
	app := testApp(t)
	raw := M{"id": "provider-order", "amount": "0.0001", "currencyMarket": "BTC", "soloMiningCoin": "BTC", "status": "COMPLETED", "sharedTicket": nil, "soloReward": []any{M{"id": "orphan", "coin": "BTC", "payoutReward": 312500000, "confirmations": -1, "depositComplete": true}, M{"id": "donated", "coin": "BTC", "payoutReward": 12345, "depositDonated": true}}}
	app.Engine.importSoloData(app.Store, raw, "fixture personal ownership")
	for _, reward := range app.Store.List("rewards") {
		assert(t, n(reward["amount"]) > 0 && !rewardAccounted(reward), "Lost source quantity or accounted excluded provider reward")
	}
	assert(t, n(totals(app.Store.List("orders"), app.Store.List("rewards"), "live")["earned"]) == 0, "Orphan credited")
}
func TestLedgerAuditDetectsLegacyDateFallback(t *testing.T) {
	o := M{"id": "old", "mode": "paper", "status": "ACTIVE", "kind": "team", "costBtc": 20000, "feeBtc": 0, "createdAt": stamp(), "spendHistory": []any{M{"at": stamp(), "amountBtc": 20100}}}
	audit := ledgerAudit(M{"settings": defaultSettings(), "orders": []M{o}, "rewards": []M{}})
	assert(t, s(maps(audit["issues"])[0]["code"]) == "SPEND_HISTORY_TOTAL_MISMATCH", "Legacy mismatch omitted")
}
func TestMultiLevelPlansAreCumulativeOnlyAfterOwnership(t *testing.T) {
	q := M{"costBtc": 10000}
	st := M{"shares": 1}
	first := obj(decode(encode(makeTeamBuyBody(q, st, nil, nil))))
	next := obj(decode(encode(makeTeamBuyBody(q, st, nil, M{"beforeCostBtc": 10000, "beforeShares": 1, "targetCostBtc": 20000, "targetShares": 2}))))
	assert(t, units(first["amount"], "first") == 10000 && n(obj(first["shares"])["small"]) == 1 && units(next["amount"], "next") == 20000 && n(obj(next["shares"])["small"]) == 2, "Wrong first vs cumulative request")
}

func TestAuditAuthFailuresRemainReadOnlyAndDoNotExpireSession(t *testing.T) {
	app := testApp(t)
	configureLive(app, true, false)
	app.Store.Set("verified", true)
	cookie := login(t, app)
	before := string(encode(app.Store.Get("settings")))
	app.Engine.APIOverride = func(c M) *NiceHash {
		api := NewNiceHash(c)
		api.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			assert(t, r.Method == "GET", "Audit sent a provider POST")
			return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"error_id":"12345678-1234-4234-8234-123456789012","errors":[{"code":2000,"message":"Invalid session"}]}`)), Header: http.Header{}}, nil
		})}
		return api
	}
	w := httpCall(t, app, "POST", "/api/audit", M{}, cookie, "http://localhost")
	assert(t, w.Code == 200, "Read failures aborted the audit")
	report := obj(decode(w.Body.Bytes()))
	assert(t, n(maps(report["probes"])[0]["httpStatus"]) == 401 && s(maps(report["probes"])[0]["providerErrorId"]) != "", "Lost provider diagnostic reference")
	assert(t, b(app.Store.Get("verified")) && string(encode(app.Store.Get("settings"))) == before, "Observational audit changed authority")
	w = httpCall(t, app, "GET", "/api/state", nil, cookie, "")
	assert(t, w.Code == 200, "Audit logged administrator out")
}

func TestAuditInspectsRejectedTeamWithoutRetry(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	p.reject = true
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 1, "Missing initial rejection")
	report := app.Engine.Audit(context.Background(), app.Connection())
	p.barrier()
	plan := maps(report["purchasePlans"])[0]
	ref := maps(plan["joinReferences"])[0]
	assert(t, plan["selectedTeamId"] == nil && b(ref["quarantined"]) && b(ref["referenceOnly"]) && b(ref["bodiesEqual"]), "Rejected target has no safe comparison: %s", encode(plan))
	assert(t, len(p.posts) == 1, "Audit retried rejected purchase")
}
