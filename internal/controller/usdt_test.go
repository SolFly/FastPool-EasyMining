package controller

import (
	"context"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func configureUSDT(a *App, p *mockProvider, levels, solo bool) M {
	p.payment, p.solo = "USDT", solo
	st := configureLive(a, levels, solo)
	st["market"], st["coin"], st["maxPrice"], st["budget"] = "USDT", "BCH", int64(10*Sat), int64(100*Sat)
	if solo {
		st["packageName"] = "Silver 5"
	}
	a.Store.Save("strategies", st)
	a.Store.Set("settings", merge(obj(a.Store.Get("settings")), M{"usdtLimits": M{"dailyCap": 100 * Sat, "weeklyCap": 500 * Sat, "monthlyCap": 2000 * Sat, "maxOrder": 50 * Sat, "reserve": 0, "stopLoss": 0, "takeProfit": 0, "paperBalance": 100 * Sat}}))
	return st
}
func TestUSDTTeamAndSoloSignedPurchases(t *testing.T) {
	for _, profile := range []string{"documented", "web", "guide"} {
		for _, solo := range []bool{false, true} {
			t.Run(profile+map[bool]string{true: "/solo", false: "/team"}[solo], func(t *testing.T) {
				a := testApp(t)
				p := newProvider(t, a)
				configureUSDT(a, p, false, solo)
				setTestProfile(a, profile)
				a.Engine.Tick(context.Background(), false)
				p.barrier()
				assert(t, len(p.posts) == 1, "No USDT purchase: %s", encode(a.Store.State()))
				o := a.Store.List("orders")[0]
				cost := int64(Sat)
				if solo {
					cost = 5 * Sat
				}
				assert(t, paymentMarket(o) == "USDT" && o["costBtc"] == nil && money(o, "costBtc") == cost && money(o, "feeBtc") == 0, "Wrong payment currency: %s", encode(o))
				body := obj(decode([]byte(s(p.posts[0]["body"]))))
				if solo {
					assert(t, s(body["buyWithCurrency"]) == "USDT", "USDT solo request omitted its payment currency")
				} else if profile != "guide" {
					assert(t, units(body["amount"], "team request") == Sat, "Wrong USDT share amount")
				}
				assert(t, n(totals(a.Store.List("orders"), nil, "live")["spend"]) == 0 && n(totals(a.Store.List("orders"), nil, "live", "USDT")["spend"]) == cost, "Mixed BTC and USDT spend")
				assert(t, n(marketBalance(obj(a.Store.Get("runtime")), "BTC")) == 2000000, "USDT purchase debited BTC wallet")
			})
		}
	}
}
func TestUSDTMultiLevelAdditions(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureUSDT(a, p, true, false)
	setTestProfile(a, "web")
	for i := 0; i < 3; i++ {
		st := a.Store.List("strategies")[0]
		st["lastBuyAt"] = nil
		a.Store.Save("strategies", st)
		a.Engine.Tick(context.Background(), false)
	}
	p.barrier()
	assert(t, len(p.posts) == 3, "Missing USDT addition: %s", encode(a.Store.State()))
	for i, post := range p.posts {
		body := obj(decode([]byte(s(post["body"]))))
		assert(t, units(body["amount"], "amount") == int64(i+1)*Sat && n(obj(body["shares"])["small"]) == int64(i+1), "Addition was not cumulative in USDT")
	}
	a.Engine.SyncNow(context.Background())
	o := a.Store.List("orders")[0]
	assert(t, money(o, "costBtc") == 3*Sat && o["costBtc"] == nil && o["pendingTeamPurchase"] == nil && purchaseCount(o) == 3, "USDT commitment was duplicated or lost: %s", encode(o))
	for _, e := range maps(o["spendHistory"]) {
		assert(t, e["amountBtc"] == nil && paymentMarket(e) == "USDT", "USDT journal used a BTC amount")
	}
}
func TestUSDTUnknownRetainsNativeReservationAcrossMarkets(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureUSDT(a, p, true, false)
	setTestProfile(a, "web")
	p.timeout = true
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	o := a.Store.List("orders")[0]
	assert(t, s(o["status"]) == "UNKNOWN" && money(o, "costBtc") == Sat && money(o, "feeBtc") == Sat/100 && o["costBtc"] == nil, "Released or mislabeled an unknown USDT intent: %s", encode(o))
	a.Engine.Tick(context.Background(), true)
	p.barrier()
	assert(t, len(p.posts) == 1, "Replayed an uncertain USDT purchase")
}
func TestContinuousBuyingSurvivesRewardAndLifetimeTargets(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	st := configureLive(a, false, false)
	st["continuous"], st["stopOnWin"], st["maxPurchases"], st["budget"] = true, true, 1, 10000
	a.Store.Save("strategies", st)
	now := stamp()
	a.Store.Save("orders", M{"id": "prior", "mode": "live", "kind": "solo", "status": "COMPLETED", "strategyId": st["id"], "packageId": "old-package", "costBtc": 10000, "feeBtc": 0, "createdAt": now})
	a.Store.Save("rewards", M{"id": "win", "orderId": "prior", "coin": "BTC", "amount": 10000, "valueBtc": 10000, "confirmed": true, "createdAt": now})
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 1, "Reward/lifetime target stopped continuous buying: %s", encode(a.Store.State()))
	st["continuous"] = false
	a.Store.Save("strategies", st)
	q := normalizePackage(p.rawTeam(), stamp(), true)
	assert(t, guard(a.Store.State(), st, q, time.Now(), false) != "", "Limited mode ignored its targets")
}
func TestUSDTRewardValuationAndReportsAreSeparate(t *testing.T) {
	a := testApp(t)
	a.Store.Set("runtime", M{"rates": M{"USDT": 0.0000125}})
	raw := M{"id": "usdt-solo", "amount": "5", "currencyMarket": "USDT", "soloMiningCoin": "BCH", "status": "COMPLETED", "createdTs": stamp(), "soloReward": []any{M{"id": "usdt-reward", "coin": "BCH", "payoutReward": Sat, "payoutRewardBtc": "0.003", "depositComplete": true, "createdTs": stamp()}}}
	o := a.Engine.importSoloData(a.Store, raw, "private order")
	r := a.Store.List("rewards")[0]
	assert(t, money(o, "costBtc") == 5*Sat && n(r["valueBtc"]) == 300000 && n(r["valueUsdt"]) == 240*Sat, "Wrong native reward valuation: %s", encode(r))
	tot := totals(a.Store.List("orders"), a.Store.List("rewards"), "live", "USDT")
	assert(t, n(tot["net"]) == 235*Sat, "Wrong USDT P&L")
	assert(t, n(totals(a.Store.List("orders"), a.Store.List("rewards"), "live")["net"]) == 0, "USDT changed BTC P&L")
	a.Store.Set("runtime", M{"rates": M{"USDT": 0.0001}})
	a.Engine.importSoloData(a.Store, raw, "private order")
	assert(t, n(a.Store.List("rewards")[0]["valueUsdt"]) == 240*Sat, "Confirmed USDT value changed with spot rates")
	report := dailyReport(a.Store.List("orders"), a.Store.List("rewards"), "live", "Europe/Sofia", 0, time.Now(), nil, "USDT")
	assert(t, n(obj(report["total"])["net"]) == 235*Sat, "Daily USDT total differs")
	csv := ledgerCSV(a.Store.State(), "live", "USDT")
	assert(t, strings.Contains(csv, "Cost USDT") && !strings.Contains(csv, "Cost BTC"), "CSV mislabeled payment amounts")
}

func TestUSDTPendingValuationRefreshesUntilConfirmation(t *testing.T) {
	r := M{"coin": "BTC", "amount": 100000, "valueBtc": 100000, "confirmed": false}
	usdtRewardValue(r, M{"USDT": 0.00001})
	assert(t, n(r["valueUsdt"]) == 100*Sat, "Bad pending conversion")
	r["confirmed"] = true
	usdtRewardValue(r, M{"USDT": 0.00002})
	assert(t, n(r["valueUsdt"]) == 50*Sat, "Confirmed value used an old pending quote")
	usdtRewardValue(r, M{"USDT": 0.00004})
	assert(t, n(r["valueUsdt"]) == 50*Sat, "Confirmed value was repriced")
}

func TestUSDTSpotRatesCanBridgeBTCAndFiat(t *testing.T) {
	r := normalizeRates(M{"list": []any{M{"fromCurrency": "USDT", "toCurrency": "BTC", "exchangeRate": 0.000012}, M{"fromCurrency": "BTC", "toCurrency": "USD", "exchangeRate": 80000}, M{"fromCurrency": "USD", "toCurrency": "EUR", "exchangeRate": 0.9}}})
	assert(t, f(fiatValue(Sat, "USDT", "USD", r)) > 0.959999 && f(fiatValue(Sat, "USDT", "USD", r)) < 0.960001, "Assumed USDT parity")
	assert(t, f(fiatValue(Sat, "USDT", "EUR", r)) > 0.863999 && f(fiatValue(Sat, "USDT", "EUR", r)) < 0.864001, "Missing three-edge fiat conversion")
}

func TestUSDTRejectedAdditionKeepsPriorCommitment(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureUSDT(a, p, true, false)
	setTestProfile(a, "web")
	a.Engine.Tick(context.Background(), false)
	a.Engine.SyncNow(context.Background())
	before := a.Store.List("orders")[0]
	st := a.Store.List("strategies")[0]
	st["lastBuyAt"] = nil
	a.Store.Save("strategies", st)
	p.mu.Lock()
	p.rejectStatus, p.rejectCode = 400, 5251
	p.mu.Unlock()
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	o := a.Store.List("orders")[0]
	assert(t, money(o, "costBtc") == Sat && o["costBtc"] == nil && o["pendingTeamPurchase"] == nil, "Rejected USDT addition changed the paid cost: %s", encode(o))
	assert(t, string(encode(o["spendHistory"])) == string(encode(before["spendHistory"])) && purchaseCount(o) == 1, "Rejected addition changed USDT spend/count")
	assert(t, b(obj(a.Store.Get("settings"))["running"]), "Team state rejection paused all buying")
	a.Engine.Tick(context.Background(), false)
	p.barrier()
	assert(t, len(p.posts) == 2, "Replayed a rejected USDT addition")
}

func TestUSDTExternalContributionAndRefundJournal(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureUSDT(a, p, false, false)
	p.shares = 1
	o := a.Engine.importTeam(p.rawTeam(), M{"USDT": 0.0000125}, nil)
	assert(t, money(o, "costBtc") == Sat && o["costBtc"] == nil, "Imported USDT into BTC")
	p.shares = 2
	o = a.Engine.importTeam(p.rawTeam(), M{"USDT": 0.0000125}, nil)
	assert(t, money(o, "costBtc") == 2*Sat && len(spendEntries(o)) == 2, "External USDT addition was not journaled")
	raw := p.rawTeam()
	maps(raw["members"])[0]["paymentStatus"] = "RETURNED"
	o = a.Engine.importTeam(raw, M{"USDT": 0.0000125}, nil)
	assert(t, money(o, "refundBtc") == 2*Sat && o["refundBtc"] == nil && netCost(o) == 0, "USDT refund was mislabeled or not deducted")
	var sum int64
	for _, entry := range spendEntries(o) {
		sum += money(entry, "amountBtc")
		assert(t, entry["amountBtc"] == nil && paymentMarket(entry) == "USDT", "USDT journal has BTC amounts")
	}
	assert(t, sum == 0 && n(totals(a.Store.List("orders"), nil, "live")["spend"]) == 0, "Refund leaked into BTC totals")
	assert(t, len(maps(ledgerAudit(a.Store.State(), "live", "USDT")["issues"])) == 0, "USDT audit falsely rejected native journal")
}

func TestUSDTReconciliationUsesNativeAmounts(t *testing.T) {
	a := testApp(t)
	a.Store.Save("orders", fundingRecord("USDT", M{"id": "uncertain", "kind": "solo", "mode": "live", "status": "UNKNOWN", "costBtc": 5 * Sat, "feeBtc": Sat / 20, "createdAt": stamp()}))
	cookie := login(t, a)
	w := httpCall(t, a, "POST", "/api/reconcile", M{"id": "uncertain", "action": "final-debit", "password": "test-password-123", "note": "Verified native USDT debit and refund", "costAmount": 5 * Sat, "refundAmount": Sat}, cookie, "http://localhost")
	assert(t, w.Code == 200, "USDT reconciliation failed: %s", w.Body)
	o := a.Store.List("orders")[0]
	assert(t, o["costBtc"] == nil && o["refundBtc"] == nil && money(o, "costBtc") == 5*Sat && money(o, "refundBtc") == Sat, "Reconciliation wrote USDT into BTC fields")
	assert(t, n(totals(a.Store.List("orders"), nil, "live", "USDT")["spend"]) == 4*Sat && n(totals(a.Store.List("orders"), nil, "live")["spend"]) == 0, "Reconciled amount entered wrong ledger")
}

func TestUSDTTeamRejectsContradictoryExecutionCurrency(t *testing.T) {
	a := testApp(t)
	p := newProvider(t, a)
	configureUSDT(a, p, false, false)
	p.shares = 1
	raw := p.rawTeam()
	raw["orderDetails"] = M{"currencyMarket": "BTC"}
	caught := attempt(func() { a.Engine.importTeam(raw, M{}, nil) })
	assert(t, caught != nil && len(a.Store.List("orders")) == 0, "Contradictory execution currency was imported")
}

func TestContinuousMigrationIsOneTimeAndDoesNotArm(t *testing.T) {
	dir := t.TempDir()
	store := OpenStore(dir)
	store.Save("strategies", M{"id": "legacy", "name": "Old strategy", "enabled": true, "stopOnWin": true, "maxPurchases": 1})
	store.Set("settings", merge(defaultSettings(), M{"mode": "live", "running": true, "liveArmed": true}))
	store.Close()
	app := NewApp(Options{DataDir: dir, Assets: fstest.MapFS{}})
	st := app.Store.List("strategies")[0]
	settings := obj(app.Store.Get("settings"))
	assert(t, b(st["continuous"]) && !b(st["stopOnWin"]) && paymentMarket(st) == "BTC", "Legacy strategy still stops on reward")
	assert(t, !b(settings["running"]) && !b(settings["liveArmed"]), "Continuous migration started real buying")
	st["continuous"], st["stopOnWin"] = false, true
	app.Store.Save("strategies", st)
	app.Store.Close()
	again := NewApp(Options{DataDir: dir, Assets: fstest.MapFS{}})
	defer again.Store.Close()
	st = again.Store.List("strategies")[0]
	assert(t, !b(st["continuous"]) && b(st["stopOnWin"]), "Restart overrode an explicit limited strategy")
}
