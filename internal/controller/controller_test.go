package controller

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

const testTeam = "c7f74c51-ccb6-4aa0-a19c-3f2f8462a8d8"
const testOrg = "11111111-1111-1111-1111-111111111111"

var testCredentials = M{"key": "fixture-key", "secret": "fixture-secret", "orgId": testOrg, "baseUrl": BaseURL}

func assert(t *testing.T, condition bool, format string, args ...any) {
	t.Helper()
	if !condition {
		t.Fatalf(format, args...)
	}
}
func TestFrozenV124Guards(t *testing.T) {
	data, err := os.ReadFile("testdata/v124-guards.json")
	must(err)
	fixture := obj(decode(data))
	assert(t, s(fixture["commit"]) == "31869544f1b186200f6f207cdce5d004e170ff7d", "Wrong baseline")
	for _, row := range maps(fixture["cases"]) {
		t.Run(s(row["name"]), func(t *testing.T) {
			actual := guard(obj(row["state"]), obj(row["strategy"]), obj(row["quote"]), parseTime(fixture["now"]), false)
			assert(t, actual == s(row["reason"]), "got %q want %q", actual, s(row["reason"]))
		})
	}
}
func TestNodeSignature(t *testing.T) {
	data, err := os.ReadFile("testdata/v124-signature.json")
	must(err)
	fixture := obj(decode(data))
	got := Sign(testCredentials, "POST", teamPath+testTeam, "", "1793102400000", "33333333-3333-4333-8333-333333333333", []byte(s(fixture["body"])))
	assert(t, got == s(fixture["signature"]), "HMAC differs from Node v1.2.4")
}
func testApp(t *testing.T) *App {
	t.Helper()
	app := NewApp(Options{DataDir: t.TempDir(), Password: "test-password-123", Assets: fstest.MapFS{"index.html": {Data: []byte("<!doctype html><h1>FastPool</h1>")}}, ServerCredentials: clone(testCredentials)})
	t.Cleanup(func() { app.Store.Close() })
	return app
}
func TestNodeMigration(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"master.key", "controller.sqlite"} {
		data, err := os.ReadFile("testdata/node-" + name)
		must(err)
		must(os.WriteFile(filepath.Join(dir, name), data, 0600))
	}
	app := NewApp(Options{DataDir: dir, Assets: fstest.MapFS{}})
	assert(t, app.checkPassword("migration-password-123"), "Node password no longer works")
	assert(t, s(app.Credentials()["secret"]) == "fixture-secret", "Node AES-GCM format failed")
	settings := obj(app.Store.Get("settings"))
	assert(t, !b(settings["running"]) && !b(settings["liveArmed"]), "Migration must pause and disarm")
	o := app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "UNKNOWN" && n(o["costBtc"]) == 20000 && n(o["feeBtc"]) == 100 && o["pendingTeamPurchase"] != nil, "Restart lost uncertain reservation: %s", encode(o))
	assert(t, len(app.Store.List("rewards")) == 1 && len(app.Store.List("strategies")) == 1, "Migration lost ledger")
	matches, err := filepath.Glob(filepath.Join(dir, "before-go-*.sqlite"))
	must(err)
	assert(t, len(matches) == 1, "No migration snapshot")
	app.Store.Close()
	again := OpenStore(dir)
	defer again.Close()
	assert(t, n(again.List("orders")[0]["costBtc"]) == 20000, "Second restart lost commitment")
}

type mockProvider struct {
	payment                                                    string
	memberRewards                                              []any
	mu                                                         sync.Mutex
	posts                                                      []M
	shares                                                     int64
	reject, timeout, details404, extra503, solo, merged, saved bool
	catalogues, details                                        int
	teamID                                                     string
	app                                                        *App
	server                                                     *httptest.Server
	t                                                          *testing.T
	pauseOnAddresses                                           bool
	rejectStatus                                               int
	rejectCode                                                 any
	rejectPath                                                 string
	includeSolo                                                bool
}

func newProvider(t *testing.T, app *App) *mockProvider {
	p := &mockProvider{app: app, t: t, teamID: testTeam}
	p.server = httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.server.Close)
	app.Engine.APIOverride = func(c M) *NiceHash {
		api := NewNiceHash(c)
		api.HTTP = p.server.Client()
		api.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
			clone := r.Clone(r.Context())
			clone.URL.Scheme = "http"
			clone.URL.Host = strings.TrimPrefix(p.server.URL, "http://")
			return http.DefaultTransport.RoundTrip(clone)
		})
		return api
	}
	return p
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }
func (p *mockProvider) barrier()                                           { p.mu.Lock(); p.mu.Unlock() }
func (p *mockProvider) rawTeam() M {
	market := strfirst(p.payment, "BTC")
	sharePrice := int64(10000)
	minimum := "0.0001"
	total := "0.0068"
	price := "0.04"
	if market == "USDT" {
		sharePrice = Sat
		minimum = "1"
		total = "68"
		price = "100"
	}
	members := []M{}
	if p.shares > 0 {
		members = append(members, M{"organizationId": testOrg, "addedAmount": decimal(p.shares * sharePrice), "paymentStatus": "OK", "shares": M{"small": p.shares}, "rewards": first(p.memberRewards, []any{})})
	}
	template := M{"id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "name": "Team Silver", "available": true, "price": price, "minShareAmount": minimum, "currencyMarket": market, "duration": 3600, "currencyAlgo": M{"currency": "BCH", "blockRewardWithNhFee": "3.125"}}
	if p.merged {
		template["currencyAlgo"] = M{"currency": "LTC", "blockRewardWithNhFee": "6.25"}
		template["mergeCurrencyAlgo"] = M{"currency": "DOGE", "blockRewardWithNhFee": "10000"}
		template["name"] = "Team Palladium"
	}
	return M{"id": p.teamID, "status": "COUNTDOWN", "state": "OPEN", "lifeTimeTill": time.Now().Add(36 * time.Second).UTC().Format(time.RFC3339Nano), "minShareAmount": minimum, "addedAmount": total, "members": members, "currencyAlgoTicket": template}
}
func (p *mockProvider) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.t.Error(err)
		return
	}
	if r.Header.Get("X-Auth") != "" {
		message := strings.Join([]string{"fixture-key", r.Header.Get("X-Time"), r.Header.Get("X-Nonce"), "", testOrg, "", r.Method, r.URL.Path, r.URL.RawQuery}, "\x00")
		if len(body) > 0 {
			message += "\x00" + string(body)
		}
		mac := hmac.New(sha256.New, []byte("fixture-secret"))
		mac.Write([]byte(message))
		p.t.Logf("signed %s %s", r.Method, r.URL.Path)
		if got := r.Header.Get("X-Auth"); got != "fixture-key:"+hex.EncodeToString(mac.Sum(nil)) {
			p.t.Errorf("Invalid HMAC: %s", got)
		}
	}
	reply := func(v any, status int) { w.WriteHeader(status); _, _ = w.Write(encode(v)) }
	if r.Method == "POST" {
		orders := p.app.Store.List("orders")
		reserved := false
		for _, o := range orders {
			if s(o["status"]) == "SUBMITTING" && money(o, "feeBtc") > 0 && paymentMarket(o) == strfirst(p.payment, "BTC") {
				reserved = true
			}
		}
		if !reserved {
			p.t.Error("Provider POST occurred before durable fee reservation")
		}
		p.posts = append(p.posts, M{"path": r.URL.Path, "body": string(body), "requestId": r.Header.Get("X-Request-Id")})
		if p.rejectStatus != 0 && (p.rejectPath == "" || p.rejectPath == r.URL.Path) {
			reply(M{"errors": []M{{"code": p.rejectCode, "message": "NiceHashErrorTranslation.SHARED_TICKET_INVALID_STATE"}}, "error_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}, p.rejectStatus)
			return
		}
		if p.timeout {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		if p.reject {
			reply(M{"errors": []M{{"code": 110, "message": "The requested resource was not found"}}}, 404)
			return
		}
		if p.solo || (p.includeSolo && strings.HasSuffix(r.URL.Path, "/hashpower/solo/order")) {
			amount := "0.0001"
			if p.payment == "USDT" {
				amount = "5"
			}
			reply(M{"id": "55555555-5555-4555-8555-555555555555", "currencyMarket": strfirst(p.payment, "BTC"), "amount": amount, "status": M{"code": "PENDING"}}, 200)
			return
		}
		p.shares = n(obj(obj(decode(body))["shares"])["small"])
		reply(M{"success": true, "successType": "SUCCESSFUL"}, 200)
		return
	}
	// Test provider accepts both explicit namespaces; HMAC verification above uses the original wire path.
	path := strings.Replace(r.URL.Path, "/hashpower/api/v2/", "/main/api/v2/", 1)
	switch path {
	case "/api/v2/time":
		reply(M{"serverTime": time.Now().UnixMilli()}, 200)
	case "/main/api/v2/accounting/accounts2":
		reply(M{"currencies": []M{{"currency": "USDT", "available": "100", "btcRate": 0.0000125}, {"currency": "BTC", "available": ".02", "btcRate": 1}, {"currency": "BCH", "available": "0", "btcRate": 0.003}}}, 200)
	case "/main/api/v2/hashpower/solo/order":
		reply(M{"list": []any{}}, 200)
	case "/main/api/v2/hashpower/solo/shared/order":
		if p.solo {
			reply(M{"list": []any{}}, 200)
		} else {
			reply(M{"list": []M{p.rawTeam()}}, 200)
		}
	case "/main/api/v2/hashpower/solo/shared/order/" + p.teamID, "/hashpower/api/v2/hashpower/solo/shared/order/" + p.teamID:
		p.details++
		if p.details404 && p.shares == 0 {
			reply(M{"errors": []M{{"code": 110, "message": "Not joined"}}}, 404)
		} else {
			reply(p.rawTeam(), 200)
		}
	case "/main/api/v2/public/solo/package":
		if p.solo || p.includeSolo {
			price, name, coin := "0.0001", "Gold S", "BTC"
			if p.payment == "USDT" {
				price, name, coin = "5", "Silver 5", "BCH"
			}
			reply([]M{{"id": "44444444-4444-4444-4444-444444444444", "name": name, "available": true, "price": price, "currencyMarket": strfirst(p.payment, "BTC"), "duration": 3600, "currencyAlgo": M{"currency": coin, "blockRewardWithNhFee": "3.125"}}}, 200)
		} else {
			reply([]any{}, 200)
		}
	case "/main/api/v2/public/solo/shared/order":
		p.catalogues++
		if p.extra503 && p.catalogues > 1 {
			reply(M{"errors": []M{{"code": 1, "message": "extra GET failed"}}}, 503)
		} else if p.solo {
			reply(M{"list": []any{}}, 200)
		} else {
			reply(M{"list": []M{p.rawTeam()}}, 200)
		}
	case "/main/api/v2/exchangeRate/list":
		reply(M{"list": []M{{"fromCurrency": "BTC", "toCurrency": "USD", "exchangeRate": "80000"}, {"fromCurrency": "USD", "toCurrency": "EUR", "exchangeRate": "0.9"}, {"fromCurrency": "BCH", "toCurrency": "BTC", "exchangeRate": "0.003"}}}, 200)
	case "/main/api/v2/hashpower/sharedTicketExternalAddress/list":
		if p.pauseOnAddresses {
			p.app.Engine.Pause("test pause during address lookup")
		}
		reply([]M{{"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "currency": "LTC", "address": "ltc1qbaselineexampledestination000000", "organizationId": testOrg}, {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "currency": "DOGE", "address": "DBaselineExampleDestination000000", "organizationId": testOrg}}, 200)
	default:
		p.t.Errorf("Unexpected provider request %s %s", r.Method, r.URL)
		reply(M{"errors": []M{{"code": 110, "message": "Unexpected fixture request"}}}, 404)
	}
}
func configureLive(app *App, levels bool, solo bool) M {
	settings := merge(defaultSettings(), M{"mode": "live", "running": true, "liveArmed": true, "autoSync": false})
	app.Store.Set("settings", settings)
	app.Store.Set("verified", true)
	st := merge(defaultStrategy(), M{"id": "strategy", "name": "Fixture strategy", "mode": "team", "kind": "team", "coin": "BCH", "packageName": "Team Silver", "enabled": true, "minTeamShares": 5, "stopOnWin": false, "budget": 1000000})
	if levels {
		st["teamLevels"] = []any{M{"threshold": 5, "shares": 1}, M{"threshold": 25, "shares": 1}, M{"threshold": 50, "shares": 1}}
	}
	if solo {
		st["mode"] = "solo"
		st["kind"] = "interval"
		st["coin"] = "BTC"
		st["packageName"] = "Gold S"
	}
	app.Store.Save("strategies", st)
	return st
}
func TestStrategyBuying(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		levels, solo, merged bool
		shares               int64
	}{{"team original", false, false, false, 1}, {"team levels first join", true, false, false, 1}, {"three shares", false, false, false, 3}, {"solo", false, true, false, 1}, {"merged saved payouts", false, false, true, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			p.solo = tc.solo
			p.merged = tc.merged
			p.details404 = true
			p.extra503 = true
			st := configureLive(app, tc.levels, tc.solo)
			st["shares"] = tc.shares
			st["maxPrice"] = tc.shares * 10000
			if tc.merged {
				st["coin"] = "LTC"
				st["packageName"] = "Team Palladium"
				st["payoutAddress"] = "ltc1qbaselineexampledestination000000"
				st["mergePayoutAddress"] = "DBaselineExampleDestination000000"
			}
			app.Store.Save("strategies", st)
			app.Engine.Tick(context.Background(), false)
			p.barrier()
			assert(t, len(p.posts) == 1, "Wanted one POST; state=%s", encode(app.Store.State()))
			body := obj(decode([]byte(s(p.posts[0]["body"]))))
			if tc.solo {
				assert(t, s(p.posts[0]["path"]) == soloPath && s(body["ticketId"]) == "44444444-4444-4444-4444-444444444444", "Solo path/body wrong")
			} else {
				assert(t, s(p.posts[0]["path"]) == teamPath+testTeam && units(body["amount"], "request") == tc.shares*10000 && n(obj(body["shares"])["small"]) == tc.shares, "Team body wrong: %s", p.posts[0]["body"])
				assert(t, p.details == 0, "First join unexpectedly requires private detail GET")
			}
			if tc.merged {
				assert(t, s(body["soloMiningRewardWithdrawalAddrId"]) == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && s(body["mergeSoloMiningRewardWithdrawalAddrId"]) == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Saved payouts missing")
			}
			assert(t, n(app.Store.List("orders")[0]["costBtc"]) == tc.shares*10000, "Wrong accepted cost")
		})
	}
}
func TestRejectedAndUnknownNeverReplay(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(fmt.Sprint("uncertain=", uncertain), func(t *testing.T) {
			app := testApp(t)
			p := newProvider(t, app)
			p.reject = !uncertain
			p.timeout = uncertain
			configureLive(app, true, false)
			app.Engine.Tick(context.Background(), false)
			p.barrier()
			orders := app.Store.List("orders")
			assert(t, len(p.posts) == 1 && len(orders) == 1, "Missing attempt")
			o := orders[0]
			if uncertain {
				assert(t, s(o["status"]) == "UNKNOWN" && n(o["feeBtc"]) == 100 && o["pendingTeamPurchase"] != nil, "Unknown reservation released")
				assert(t, !b(obj(app.Store.Get("settings"))["liveArmed"]), "Uncertain must disarm")
			} else {
				failure := obj(o["submissionFailure"])
				assert(t, s(o["status"]) == "FAILED" && o["externalId"] == nil && n(o["feeBtc"]) == 0 && b(failure["rejected"]), "Confirmed rejection misclassified")
				assert(t, s(obj(failure["teamCheck"])["finding"]) == "still-listed-after-rejection", "Expected still listed evidence")
				assert(t, n(obj(failure["request"])["payloadBytes"]) > 0 && s(obj(failure["request"])["payloadSHA256"]) != "", "Missing request fingerprint")
			}
			app.Engine.Tick(context.Background(), true)
			p.barrier()
			assert(t, len(p.posts) == 1, "Replayed provider POST")
			if !uncertain {
				d := diagnostics(app.Store.State(), app.Connection())
				assert(t, len(maps(d["failures"])) == 1, "Duplicate diagnostic failure")
				assert(t, strings.Contains(s(maps(d["currentDecisions"])[0]["reason"]), "NiceHash rejected"), "Misleading no-unfilled-level message: %s", encode(d))
			}
		})
	}
}
func TestManualSingleUse(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, false, false)
	settings := obj(app.Store.Get("settings"))
	settings["running"] = false
	app.Store.Set("settings", settings)
	review := obj(app.Engine.Quote(context.Background(), M{"packageId": testTeam, "shares": 2}))
	result := obj(app.Engine.ManualBuy(context.Background(), M{"quoteId": review["id"]}))
	assert(t, !b(result["replayed"]) && len(p.posts) == 1 && n(obj(result["order"])["costBtc"]) == 20000, "Manual purchase failed")
	again := obj(app.Engine.ManualBuy(context.Background(), M{"quoteId": review["id"]}))
	assert(t, b(again["replayed"]) && len(p.posts) == 1, "Single-use review replayed POST")
}
func TestTeamAdditions(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	for i := 1; i < 3; i++ {
		st := app.Store.List("strategies")[0]
		st["lastBuyAt"] = time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339Nano)
		app.Store.Save("strategies", st)
		app.Engine.Tick(context.Background(), false)
		p.barrier()
	}
	assert(t, len(p.posts) == 3 && p.shares == 3, "Expected three cumulative purchases: %s", encode(app.Store.State()))
	for i, post := range p.posts {
		body := obj(decode([]byte(s(post["body"]))))
		assert(t, n(obj(body["shares"])["small"]) == int64(i+1) && units(body["amount"], "request") == int64(i+1)*10000, "Wrong cumulative addition")
		if i > 0 {
			assert(t, s(post["requestId"]) != s(p.posts[i-1]["requestId"]), "Request ID reused")
		}
	}
	orders := app.Store.List("orders")
	assert(t, len(orders) == 1 && n(orders[0]["costBtc"]) == 30000, "Duplicate team or wrong ledger cost")
	app.Engine.SyncNow(context.Background())
	order := app.Store.List("orders")[0]
	assert(t, order["pendingTeamPurchase"] == nil && purchaseCount(order) == 3, "Levels not confirmed")
	assert(t, len(spendEntries(order)) >= 3, "Lost per-addition spending dates")
}
func TestRejectedAdditionRetainsEarlierCommitment(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	st := app.Store.List("strategies")[0]
	st["lastBuyAt"] = nil
	app.Store.Save("strategies", st)
	p.reject = true
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	o := app.Store.List("orders")[0]
	assert(t, n(o["costBtc"]) == 10000 && n(o["shares"]) == 1 && s(o["externalId"]) == testTeam && len(maps(o["teamBuys"])) == 2, "Earlier participation lost: %s", encode(o))
	assert(t, purchaseCount(o) == 1, "Rejected addition consumed successful purchase count")
}
func TestPauseDuringAddressLookup(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	p.merged = true
	p.pauseOnAddresses = true
	st := configureLive(app, false, false)
	st["coin"] = "LTC"
	st["packageName"] = "Team Palladium"
	st["payoutAddress"] = "ltc1qbaselineexampledestination000000"
	app.Store.Save("strategies", st)
	caught := attempt(func() { app.Engine.Tick(context.Background(), false) })
	assert(t, caught != nil && len(p.posts) == 0 && len(app.Store.List("orders")) == 0, "Pause did not prevent POST")
}
func TestDecimalPrecision(t *testing.T) {
	for _, value := range []any{"1e-4", "0.000100000000", M{"value": "0.0001"}, json.Number("0.0001")} {
		assert(t, units(value, "test") == 10000, "Wrong decimal %v", value)
	}
	assert(t, sumUnits([]any{"0.000000005", "0.000000005"}, "reward") == 1, "Rounded pieces instead of aggregate")
	for _, v := range []any{"-1", "1e-1001", "90071992.54740992", "0.000000001", "NaN"} {
		assert(t, attempt(func() { units(v, "bad") }) != nil, "Accepted invalid exact amount %v", v)
	}
}
func TestPersonalTeamRewardsAndDeduplication(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	p.shares = 10
	raw := p.rawTeam()
	raw["addedAmount"] = "0.0041"
	raw["orderDetails"] = M{"id": "55555555-5555-4555-8555-555555555555", "status": "COMPLETED", "endTs": "2026-10-25T18:51:00Z", "soloReward": []any{M{"coin": "BCH", "depositComplete": true, "payoutReward": 312500000}}}
	member := maps(raw["members"])[0]
	member["addedAmount"] = "0.0010"
	member["claimed"] = true
	member["rewards"] = []any{M{"coin": "BCH", "rewardAmount": "0.7622", "rewardFeeAmount": "0.01"}}
	raw["members"] = []M{member}
	alias := M{"id": "alias", "externalId": obj(raw["orderDetails"])["id"], "mode": "live", "kind": "solo", "status": "COMPLETED", "costBtc": 410000, "source": "NiceHash import", "createdAt": "2026-10-25T18:51:00Z"}
	app.Store.Save("orders", alias)
	app.Store.Save("rewards", M{"id": "whole", "orderId": "alias", "coin": "BCH", "amount": 312500000, "confirmed": true, "valueBtc": 1000000, "createdAt": stamp()})
	o := app.Engine.importTeam(raw, M{"BCH": 0.003}, nil)
	assert(t, n(o["costBtc"]) == 100000 && s(o["kind"]) == "team", "Personal contribution wrong")
	blocks := maps(obj(o["rewardEstimate"])["blocks"])
	assert(t, n(blocks[0]["amount"]) == 76219512, "Personal per-block allocation wrong: %s", encode(blocks))
	app.Engine.importTeam(raw, M{"BCH": 0.003}, nil)
	rewards := app.Store.List("rewards")
	total := totals(app.Store.List("orders"), rewards, "live")
	assert(t, n(total["earned"]) == 228660 && n(total["spend"]) == 100000, "Whole team, fee subtraction or duplication inflated ledger: %s", encode(total))
	assert(t, len(rewards) == 2, "Repeated sync duplicated reward")
	assert(t, s(findBy(app.Store.List("orders"), "id", "alias")["status"]) == "SUPERSEDED", "Duplicate execution not superseded")
}
func TestDailyProfitTimezoneAndPending(t *testing.T) {
	orders := []M{{"id": "o", "mode": "live", "kind": "team", "status": "PENDING", "costBtc": 20000, "feeBtc": 0, "createdAt": "2026-10-25T20:30:00Z", "spendHistory": []any{M{"at": "2026-10-25T20:30:00Z", "amountBtc": 10000}, M{"at": "2026-10-25T22:30:00Z", "amountBtc": 10000}}, "teamBuys": []any{M{"status": "CONFIRMED", "createdAt": "2026-10-25T20:30:00Z"}, M{"status": "PENDING", "createdAt": "2026-10-25T22:30:00Z"}}}}
	rewards := []M{{"id": "r", "orderId": "o", "coin": "BCH", "amount": 100, "confirmed": true, "valueBtc": 30000, "createdAt": "2026-10-25T20:30:00Z", "confirmedAt": "2026-10-26T00:00:00Z"}, {"id": "p", "orderId": "o", "coin": "BCH", "amount": 100, "confirmed": false, "valueBtc": 50000, "createdAt": "2026-10-26T00:00:00Z"}}
	report := dailyReport(orders, rewards, "live", "Europe/Sofia", 3, parseTime("2026-10-27T12:00:00Z"), M{})
	rows := maps(report["rows"])
	assert(t, n(rows[0]["spend"]) == 10000 && n(rows[1]["spend"]) == 10000 && n(rows[1]["earned"]) == 30000, "Local calendar bucketing wrong: %s", encode(report))
	assert(t, n(obj(report["total"])["net"]) == 10000 && n(obj(report["total"])["pending"]) == 50000, "Pending affected daily net")
}
func httpCall(t *testing.T, app *App, method, path string, body M, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(string(encode(body))))
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}
func login(t *testing.T, app *App) *http.Cookie {
	w := httpCall(t, app, "POST", "/api/auth/login", M{"password": "test-password-123"}, nil, "http://localhost")
	assert(t, w.Code == 200, "Login failed: %s", w.Body)
	return w.Result().Cookies()[0]
}
func TestHTTPAuthImportsExports(t *testing.T) {
	app := testApp(t)
	w := httpCall(t, app, "GET", "/api/state", nil, nil, "")
	assert(t, w.Code == 401, "State exposed")
	w = httpCall(t, app, "POST", "/api/auth/login", M{"password": "test-password-123"}, nil, "https://evil.example")
	assert(t, w.Code == 403, "Cross-origin mutation accepted")
	cookie := login(t, app)
	backup := M{"kind": "fastpool-easymining-settings", "schemaVersion": 1, "settings": merge(defaultSettings(), M{"mode": "live", "running": true, "liveArmed": true}), "strategies": []any{merge(defaultStrategy(), M{"id": "s", "name": "Imported", "enabled": true, "lastBuyAt": "2026-10-27T12:00:00Z"})}}
	w = httpCall(t, app, "POST", "/api/import", M{"backup": backup, "options": M{"strategyMode": "merge"}}, cookie, "http://localhost")
	assert(t, w.Code == 200, "Import failed: %s", w.Body)
	settings := obj(app.Store.Get("settings"))
	assert(t, !b(settings["running"]) && !b(settings["liveArmed"]) && !b(app.Store.List("strategies")[0]["enabled"]), "Import granted buying authority")
	for _, format := range []string{"settings", "purchase-diagnostics", "daily-csv", "csv", "json"} {
		w = httpCall(t, app, "GET", "/api/export?format="+format+"&days=7", nil, cookie, "")
		assert(t, w.Code == 200 && !strings.Contains(w.Body.String(), "fixture-secret") && !strings.Contains(w.Body.String(), "fixture-key"), "Unsafe or failed export %s: %s", format, w.Body)
	}
	prior := string(encode(app.Store.State()["strategies"]))
	backup["strategies"] = []any{M{"name": "Invalid", "shares": -1}}
	w = httpCall(t, app, "POST", "/api/import", M{"backup": backup}, cookie, "http://localhost")
	assert(t, w.Code == 400 && string(encode(app.Store.State()["strategies"])) == prior, "Invalid import partially applied")
}
func TestUpstream401DoesNotLogOut(t *testing.T) {
	app := testApp(t)
	cookie := login(t, app)
	app.Engine.APIOverride = func(c M) *NiceHash {
		api := NewNiceHash(c)
		api.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			status := 200
			data := M{"serverTime": time.Now().UnixMilli()}
			if strings.Contains(r.URL.Path, "accounting") {
				status = 401
				data = M{"errors": []any{M{"code": 2000, "message": "Authentication failed"}}}
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(string(encode(data)))), Header: http.Header{}}, nil
		})}
		return api
	}
	w := httpCall(t, app, "POST", "/api/sync", M{}, cookie, "http://localhost")
	assert(t, w.Code == 502 && strings.Contains(w.Body.String(), "NICEHASH_API_ERROR"), "Upstream error became local unauthorized")
	w = httpCall(t, app, "GET", "/api/state", nil, cookie, "")
	assert(t, w.Code == 200, "Upstream failure logged out administrator")
}

func TestUnknownAdditionRestartAndResolution(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	st := app.Store.List("strategies")[0]
	st["lastBuyAt"] = nil
	app.Store.Save("strategies", st)
	p.timeout = true
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	o := app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "UNKNOWN" && n(o["costBtc"]) == 20000 && n(o["feeBtc"]) == 100 && n(obj(obj(o["pendingTeamPurchase"])["before"])["costBtc"]) == 10000, "Uncertain addition lost prior cost or reservation: %s", encode(o))
	resolveUnbought(o, "Verified no extra debit in provider statement")
	app.Store.Save("orders", o)
	assert(t, n(o["costBtc"]) == 10000 && n(o["shares"]) == 1 && purchaseCount(o) == 1 && s(o["status"]) == "PENDING", "Resolving failed addition discarded earlier shares")
}
func TestImportRetainsLedgerBudgetAndCooldown(t *testing.T) {
	app := testApp(t)
	st := configureLive(app, true, false)
	st["lastBuyAt"] = "2026-10-27T17:00:00Z"
	app.Store.Save("strategies", st)
	order := M{"id": "existing", "mode": "live", "kind": "team", "status": "COMPLETED", "costBtc": 10000, "createdAt": "2026-10-27T18:00:00Z", "strategyId": st["id"]}
	app.Store.Save("orders", order)
	backup := M{"settings": defaultSettings(), "strategies": []any{merge(st, M{"lastBuyAt": "2026-10-26T12:00:00Z"})}}
	app.Engine.Import(backup, M{"strategyMode": "replace"})
	after := app.Store.List("strategies")[0]
	assert(t, s(after["id"]) == s(st["id"]) && s(after["lastBuyAt"]) == "2026-10-27T18:00:00Z" && len(app.Store.List("orders")) == 1, "Import reset ledger links or cooldown")
}
func TestMalformedSuccessRetainsReservation(t *testing.T) {
	app := testApp(t)
	configureLive(app, true, false)
	p := newProvider(t, app)
	base := app.Engine.APIOverride
	app.Engine.APIOverride = func(c M) *NiceHash {
		api := base(c)
		transport := api.HTTP.Transport
		api.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method == "POST" {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":false}`)), Header: http.Header{}}, nil
			}
			return transport.RoundTrip(r)
		})
		return api
	}
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	o := app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "UNKNOWN" && n(o["feeBtc"]) == 100, "Malformed success released reservation")
	assert(t, len(p.posts) == 0, "Unexpected mock route")
}
func TestTeamRewardPrecisionAndDecreaseHold(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	p.shares = 1
	raw := p.rawTeam()
	member := maps(raw["members"])[0]
	member["rewards"] = []any{M{"coin": "BCH", "rewardAmount": "0.000000005"}, M{"coin": "BCH", "rewardAmount": "0.000000005"}}
	raw["members"] = []M{member}
	o := app.Engine.importTeam(raw, M{"BCH": 0.003}, nil)
	rewards := app.Store.List("rewards")
	assert(t, len(rewards) == 1 && n(rewards[0]["amount"]) == 1, "Fractional personal payout did not floor aggregate once")
	member["rewards"] = []any{M{"coin": "BCH", "rewardAmount": "0"}}
	raw["members"] = []M{member}
	app.Engine.importTeam(raw, M{"BCH": 0.003}, nil)
	o = findBy(app.Store.List("orders"), "id", o["id"])
	assert(t, s(o["status"]) == "UNKNOWN" && held(o), "Decreasing payout was silently accepted")
}
func TestMembershipIsolation(t *testing.T) {
	for _, row := range []struct {
		raw  M
		want string
	}{{M{"members": []any{}}, "unjoined"}, {M{"members": []any{M{"organizationId": "22222222-2222-4222-8222-222222222222", "addedAmount": "0.0001"}}}, "unrelated"}, {M{"myAddedAmount": "0.0001", "members": []any{}}, "unattributed"}, {M{"members": M{testOrg: M{"addedAmount": "0.0001"}}}, "owned"}} {
		member, state := membership(row.raw, testOrg)
		assert(t, state == row.want, "Membership %s want %s", state, row.want)
		if state == "owned" {
			assert(t, member != nil, "Missing owner member")
		}
	}
}
func TestExchangeRatesCrossAndDisplayOnly(t *testing.T) {
	rates := normalizeRates(M{"list": []any{M{"fromCurrency": "BTC", "toCurrency": "USD", "exchangeRate": "80000"}, M{"fromCurrency": "EUR", "toCurrency": "USD", "exchangeRate": "1.25"}, M{"fromCurrency": "BCH", "toCurrency": "USD", "exchangeRate": "240"}}})
	assert(t, f(fiatValue(Sat, "BTC", "EUR", rates)) == 64000, "EUR inverse conversion wrong")
	assert(t, f(obj(rates["btc"])["BCH"]) == 0.003, "USD cross BTC rate wrong")
	assert(t, fiatValue(Sat, "ZEC", "USD", rates) == nil, "Missing rate invented")
}
func TestLeaseAndAtomicRollback(t *testing.T) {
	app := testApp(t)
	assert(t, app.Store.Acquire("other"), "Initial lease failed")
	caught := attempt(func() { app.Engine.exclusive(func(string) any { t.Fatal("Entered protected operation"); return nil }) })
	assert(t, caught != nil, "Concurrent purchase lease accepted")
	app.Store.Release("other")
	caught = attempt(func() {
		app.Store.Batch(func(tx *Store) {
			tx.Save("orders", M{"id": "rolled-back", "mode": "live", "status": "UNKNOWN"})
			fail("Abort transaction")
		})
	})
	assert(t, caught != nil && len(app.Store.List("orders")) == 0, "Transaction partially committed")
}
func TestUnsavedPayoutRequiresTwofaBeforeIntent(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, false, false)
	review := obj(app.Engine.Quote(context.Background(), M{"packageId": testTeam, "shares": 1, "payoutAddress": "bitcoincash:qexampleunsaveddestination000000"}))
	caught := attempt(func() { app.Engine.ManualBuy(context.Background(), M{"quoteId": review["id"]}) })
	assert(t, caught != nil && len(app.Store.List("orders")) == 0 && len(p.posts) == 0, "Missing 2FA consumed review or created intent")
	stored := obj(app.Store.Get("purchase-quote:" + s(review["id"])))
	assert(t, stored["orderId"] == nil, "Missing 2FA consumed single-use review")
}
func TestDiagnosticExcludesSecretsAndDestinations(t *testing.T) {
	app := testApp(t)
	app.Store.Save("orders", M{"id": "o", "kind": "team", "mode": "live", "status": "FAILED", "packageId": testTeam, "payoutAddress": "private-payout-value", "submissionFailure": M{"at": stamp(), "requestId": "r", "rejected": true, "httpStatus": 404, "providerMessage": "fixture-secret", "request": M{"amount": json.Number("0.0001"), "shares": M{"small": 1}, "soloMiningRewardAddr": "private-payout-value", "payoutFieldNames": []string{"soloMiningRewardAddr"}}}})
	text := string(encode(diagnostics(app.Store.State(), app.Connection())))
	assert(t, !strings.Contains(text, "fixture-key") && !strings.Contains(text, "fixture-secret") && !strings.Contains(text, testOrg) && !strings.Contains(text, "private-payout-value"), "Diagnostic leaked private fields: %s", text)
}

func TestInvalidLocalMutationDoesNotInvalidateVerifiedHistory(t *testing.T) {
	app := testApp(t)
	configureLive(app, false, false)
	app.Store.Set("runtime", M{"historyComplete": true, "errors": 0})
	cookie := login(t, app)
	w := httpCall(t, app, "POST", "/api/strategies", M{"shares": -1}, cookie, "http://localhost")
	assert(t, w.Code == 400, "Expected validation failure")
	rt := obj(app.Store.Get("runtime"))
	assert(t, b(rt["historyComplete"]) && n(rt["errors"]) == 0, "Local validation error blocked live buying")
}
func TestInvalidJSONObject(t *testing.T) {
	app := testApp(t)
	cookie := login(t, app)
	r := httptest.NewRequest("POST", "http://localhost/api/strategies", strings.NewReader(`[]`))
	r.Header.Set("Origin", "http://localhost")
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	assert(t, w.Code == 400 && len(app.Store.List("strategies")) == 0, "Non-object request accepted")
	assert(t, attempt(func() { decode([]byte(`{"success":true} {"other":false}`)) }) != nil, "Trailing JSON accepted")
}
func TestMissingMasterKeyRefusesExistingDatabase(t *testing.T) {
	dir := t.TempDir()
	must(os.WriteFile(filepath.Join(dir, "controller.sqlite"), []byte("existing"), 0600))
	caught := attempt(func() { OpenStore(dir) })
	assert(t, caught != nil, "Generated replacement key beside existing database")
	_, err := os.Stat(filepath.Join(dir, "master.key"))
	assert(t, os.IsNotExist(err), "Changed credential key")
}

func TestSyncRetainsNewRewardDecreaseHold(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	configureLive(app, true, false)
	app.Engine.Tick(context.Background(), false)
	p.barrier()
	p.mu.Lock()
	p.memberRewards = []any{M{"coin": "BCH", "rewardAmount": "0.1"}}
	p.mu.Unlock()
	app.Engine.SyncNow(context.Background())
	p.barrier()
	p.mu.Lock()
	p.memberRewards = []any{M{"coin": "BCH", "rewardAmount": "0.01"}}
	p.mu.Unlock()
	result := obj(app.Engine.SyncNow(context.Background()))
	o := app.Store.List("orders")[0]
	assert(t, s(o["status"]) == "UNKNOWN" && held(o) && !b(result["historyComplete"]), "Sync warning restored stale order over new reward hold: %s", encode(o))
}
func TestForeignCurrencyCannotEnterBTCLedger(t *testing.T) {
	app := testApp(t)
	p := newProvider(t, app)
	p.shares = 1
	raw := p.rawTeam()
	obj(raw["currencyAlgoTicket"])["currencyMarket"] = "USDT"
	team := app.Engine.importTeam(raw, nil, nil)
	solo := app.Engine.importSoloData(app.Store, M{"id": "foreign", "amount": "10", "currencyMarket": "USDT", "soloReward": []any{}}, "private order")
	assert(t, paymentMarket(team) == "USDT" && paymentMarket(solo) == "USDT" && team["costBtc"] == nil && solo["costBtc"] == nil, "USDT occupied a BTC cost field")
	assert(t, n(totals(app.Store.List("orders"), nil, "live")["spend"]) == 0, "USDT entered BTC totals")
	assert(t, n(totals(app.Store.List("orders"), nil, "live", "USDT")["spend"]) > 0, "USDT missing from its own ledger")
}
