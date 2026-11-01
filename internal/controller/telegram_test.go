package controller

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const telegramToken = "123456789:fixture_token_abcdefghijklmnopqrstuvwxyz"
const telegramChat = "-1009876543210"

type telegramFixture struct {
	mu         sync.Mutex
	messages   []M
	code       int
	retryAfter int64
}

func telegramMock(t *testing.T, a *App) *telegramFixture {
	t.Helper()
	p := &telegramFixture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		assert(t, r.Method == "POST" && r.URL.Path == "/bot"+telegramToken+"/sendMessage", "Unexpected Telegram endpoint")
		data, err := io.ReadAll(r.Body)
		must(err)
		body := obj(decode(data))
		assert(t, s(body["chat_id"]) == telegramChat, "Wrong Telegram target")
		assert(t, body["parse_mode"] == nil && body["allow_paid_broadcast"] == nil, "Enabled formatting or paid broadcasts")
		p.messages = append(p.messages, body)
		w.Header().Set("Content-Type", "application/json")
		if p.code != 0 {
			w.WriteHeader(p.code)
			_, _ = w.Write(encode(M{"ok": false, "error_code": p.code, "description": "fixture leaked " + telegramToken + " " + telegramChat, "parameters": M{"retry_after": p.retryAfter}}))
			return
		}
		_, _ = w.Write(encode(M{"ok": true, "result": M{"message_id": len(p.messages)}}))
	}))
	t.Cleanup(server.Close)
	a.Telegram.HTTP = &http.Client{Timeout: time.Second, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		c := r.Clone(r.Context())
		c.URL.Scheme = "http"
		c.URL.Host = strings.TrimPrefix(server.URL, "http://")
		return http.DefaultTransport.RoundTrip(c)
	})}
	return p
}
func enableTelegram(a *App, extra M) {
	a.Telegram.Configure(merge(M{"enabled": true, "purchases": true, "dailyReports": false, "token": telegramToken, "chatId": telegramChat}, extra))
}
func (p *telegramFixture) set(code int, retry int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code, p.retryAfter = code, retry
}
func (p *telegramFixture) snapshot() []M {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]M{}, p.messages...)
}
func addTelegramReceipt(a *App, id string, at time.Time, extra M) M {
	o := merge(M{"id": id, "externalId": id + "-provider", "strategyId": "strategy", "name": "Team Silver", "coin": "BCH", "kind": "team", "mode": "live", "status": "PENDING", "costBtc": 10000, "shares": 1, "createdAt": at.UTC().Format(time.RFC3339Nano), "purchaseReceipts": []M{{"requestId": id + "-request", "at": at.UTC().Format(time.RFC3339Nano), "amount": 10000, "shares": 1, "totalAmount": 10000, "totalShares": 1}}}, extra)
	a.Store.Save("orders", o)
	return o
}
func TestTelegramConfigEncryptionAndHTTPPrivacy(t *testing.T) {
	a := testApp(t)
	p := telegramMock(t, a)
	w := httpCall(t, a, "POST", "/api/telegram", M{"enabled": true}, nil, "http://localhost")
	assert(t, w.Code == 401, "Telegram mutation lacks authentication")
	cookie := login(t, a)
	w = httpCall(t, a, "POST", "/api/telegram", M{"enabled": true, "token": telegramToken, "chatId": telegramChat, "threadId": 12, "reportTime": "06:15"}, cookie, "https://evil.example")
	assert(t, w.Code == 403, "Cross-origin Telegram mutation accepted")
	w = httpCall(t, a, "POST", "/api/telegram", M{"enabled": true, "token": telegramToken, "chatId": telegramChat, "threadId": 12, "reportTime": "06:15"}, cookie, "http://localhost")
	assert(t, w.Code == 200, "Cannot configure Telegram: %s", w.Body)
	sealed := s(a.Store.Get("telegramCredentials"))
	assert(t, sealed != "" && !strings.Contains(sealed, telegramToken) && !strings.Contains(sealed, telegramChat), "Stored plaintext Telegram credentials")
	assert(t, len(p.snapshot()) == 0, "Saving Telegram settings sent a message")
	for _, path := range []string{"/api/state", "/api/telegram", "/api/export", "/api/export?format=settings", "/api/export?format=purchase-diagnostics", "/api/debug"} {
		w = httpCall(t, a, "GET", path, nil, cookie, "")
		assert(t, w.Code == 200 && !strings.Contains(w.Body.String(), telegramToken) && !strings.Contains(w.Body.String(), telegramChat), "Telegram credentials leaked at %s", path)
	}
	a.Telegram.Configure(M{"token": "", "chatId": "", "reportTime": "07:00"})
	assert(t, s(a.Telegram.credentials()["token"]) == telegramToken, "Blank fields discarded saved credentials")
	for _, input := range []M{{"token": "bad"}, {"chatId": "https://evil.example"}, {"reportTime": "25:00"}, {"threadId": -1}, {"enabled": "true"}} {
		assert(t, attempt(func() { a.Telegram.Configure(input) }) != nil, "Invalid Telegram input accepted")
	}
	a.Telegram.Configure(M{"clear": true})
	assert(t, !b(a.Telegram.Status()["configured"]) && !b(a.Telegram.Status()["enabled"]), "Removing Telegram retained a working connection")
}
func TestTelegramNativeAcceptedPurchasesAndLevelDedup(t *testing.T) {
	for _, usdt := range []bool{false, true} {
		t.Run(map[bool]string{false: "BTC", true: "USDT"}[usdt], func(t *testing.T) {
			a := testApp(t)
			nh := newProvider(t, a)
			tg := telegramMock(t, a)
			if usdt {
				configureUSDT(a, nh, true, false)
			} else {
				configureLive(a, true, false)
			}
			setTestProfile(a, "web")
			enableTelegram(a, nil)
			for step := 0; step < 2; step++ {
				st := a.Store.List("strategies")[0]
				st["lastBuyAt"] = nil
				a.Store.Save("strategies", st)
				a.Engine.Tick(context.Background(), false)
				assert(t, len(tg.snapshot()) == step, "Purchase blocked on Telegram network")
				a.Telegram.Background(context.Background(), time.Now().Add(time.Second))
				a.Telegram.Background(context.Background(), time.Now().Add(2*time.Second))
			}
			nh.barrier()
			messages := tg.snapshot()
			assert(t, len(nh.posts) == 2 && len(messages) == 2, "Missing or duplicated native purchase alerts")
			second := s(messages[1]["text"])
			amount := "0.00010000 BTC"
			total := "0.00020000 BTC"
			if usdt {
				amount = "1.00000000 USDT"
				total = "2.00000000 USDT"
			}
			assert(t, strings.Contains(second, "Payment: "+amount) && strings.Contains(second, "Team commitment: "+total) && strings.Contains(second, "Shares added: 1 · total owned: 2"), "Wrong incremental purchase notification: %s", second)
			again := NewTelegram(a.Store)
			again.HTTP = a.Telegram.HTTP
			again.Background(context.Background(), time.Now().Add(3*time.Second))
			assert(t, len(tg.snapshot()) == 2, "Restart replayed delivered notifications")
		})
	}
}
func TestTelegramManualSoloPurchaseAndRejectedAttempts(t *testing.T) {
	a := testApp(t)
	nh := newProvider(t, a)
	tg := telegramMock(t, a)
	configureLive(a, false, true)
	nh.solo = true
	setTestProfile(a, "web")
	enableTelegram(a, nil)
	q := obj(a.Engine.Quote(context.Background(), M{"packageId": "44444444-4444-4444-4444-444444444444", "shares": 1}))
	// Use the actual catalogue ID instead of relying on a notification-side lookup.
	if q == nil {
		t.Fatal("No manual quote")
	}
	result := obj(a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]}))
	assert(t, result["order"] != nil, "Manual purchase missing")
	a.Telegram.Background(context.Background(), time.Now().Add(time.Second))
	assert(t, len(tg.snapshot()) == 1 && strings.Contains(s(tg.snapshot()[0]["text"]), "Manual web purchase"), "Manual solo alert was not sent")
	a.Engine.ManualBuy(context.Background(), M{"quoteId": q["id"]})
	a.Telegram.Background(context.Background(), time.Now().Add(2*time.Second))
	assert(t, len(tg.snapshot()) == 1, "Manual replay duplicated the alert")
}
func TestTelegramSkipsHistoricalPaperAndUncertainPurchases(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, nil)
	now := time.Now().Add(time.Second)
	addTelegramReceipt(a, "historical", now.Add(-time.Hour), nil)
	addTelegramReceipt(a, "paper", now, M{"mode": "paper"})
	addTelegramReceipt(a, "uncertain", now, M{"status": "UNKNOWN"})
	addTelegramReceipt(a, "rejected", now, M{"status": "FAILED"})
	a.Telegram.Background(context.Background(), now)
	assert(t, len(tg.snapshot()) == 0, "Historical/paper/unconfirmed purchase produced a success notification")
	addTelegramReceipt(a, "accepted", now, nil)
	a.Telegram.Background(context.Background(), now)
	assert(t, len(tg.snapshot()) == 1, "Accepted live receipt was not delivered")
}
func TestTelegramRetryAfterDoesNotPauseOrReplayBuying(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, nil)
	settings := merge(defaultSettings(), M{"mode": "live", "running": true, "liveArmed": true})
	a.Store.Set("settings", settings)
	now := time.Now().Add(time.Second)
	addTelegramReceipt(a, "retry", now, nil)
	tg.set(429, 120)
	a.Telegram.Background(context.Background(), now)
	a.Telegram.Background(context.Background(), now.Add(time.Minute))
	assert(t, len(tg.snapshot()) == 1, "Ignored Telegram retry_after")
	assert(t, b(obj(a.Store.Get("settings"))["running"]) && b(obj(a.Store.Get("settings"))["liveArmed"]), "Telegram failure paused or disarmed buying")
	assert(t, !strings.Contains(s(a.Telegram.Status()["lastError"]), telegramToken), "Provider error leaked bot token")
	tg.mu.Lock()
	tg.code = 0
	tg.mu.Unlock()
	a.Telegram.Background(context.Background(), now.Add(121*time.Second))
	assert(t, len(tg.snapshot()) == 2 && n(a.Telegram.Status()["pending"]) == 0, "Telegram retry did not recover")
	a.Telegram.Background(context.Background(), now.Add(180*time.Second))
	assert(t, len(tg.snapshot()) == 2, "Delivered retry was sent again")
}
func TestTelegramDailyScheduleAndTimezoneBoundary(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, M{"dailyReports": true, "reportTime": "00:05", "purchases": false})
	loc, err := time.LoadLocation("Europe/Sofia")
	must(err)
	// The previous Sofia day spans 25 hours when daylight saving time ends.
	before := time.Date(2026, 10, 26, 0, 4, 0, 0, loc)
	due := before.Add(time.Minute)
	a.Telegram.Background(context.Background(), before)
	assert(t, len(tg.snapshot()) == 0, "Daily report sent before local schedule")
	a.Telegram.Background(context.Background(), due)
	a.Telegram.Background(context.Background(), due.Add(time.Hour))
	assert(t, len(tg.snapshot()) == 1 && strings.Contains(s(tg.snapshot()[0]["text"]), "2026-10-25 · Europe/Sofia"), "Daily report used the wrong calendar day")
	assert(t, s(a.Telegram.Status()["lastDailyDate"]) == "2026-10-25", "Daily delivery status missing")
	again := NewTelegram(a.Store)
	again.HTTP = a.Telegram.HTTP
	again.Background(context.Background(), due.Add(2*time.Hour))
	assert(t, len(tg.snapshot()) == 1, "Restart duplicated a daily report")
	a.Telegram.QueueReport(due.Add(3 * time.Hour))
	again.Background(context.Background(), due.Add(3*time.Hour))
	assert(t, len(tg.snapshot()) == 1, "Manual report duplicated today's scheduled report")
	again.Background(context.Background(), due.AddDate(0, 0, 1))
	assert(t, len(tg.snapshot()) == 2, "Next daily report was not sent while buying was paused")
}
func TestTelegramDailyAmountsMatchSeparateLedgers(t *testing.T) {
	now := parseTime("2026-10-26T06:00:00Z")
	at := "2026-10-25T21:30:00Z" // Oct 25 in Sofia after DST ends.
	btc := M{"id": "b", "mode": "live", "kind": "solo", "status": "COMPLETED", "costBtc": 10000, "feeBtc": 100, "refundBtc": 0, "createdAt": at}
	usdt := fundingRecord("USDT", M{"id": "u", "mode": "live", "kind": "solo", "status": "COMPLETED", "costBtc": 5 * Sat, "refundBtc": Sat, "createdAt": at})
	state := M{"settings": defaultSettings(), "orders": []M{btc, usdt}, "rewards": []M{{"id": "br", "orderId": "b", "coin": "BCH", "amount": Sat, "valueBtc": 20000, "confirmed": true, "createdAt": at, "confirmedAt": at}, {"id": "ur", "orderId": "u", "coin": "BTC", "amount": 1000, "valueBtc": 1000, "valueUsdt": 6 * Sat, "confirmed": true, "createdAt": at, "confirmedAt": at}, {"id": "pending", "orderId": "u", "coin": "BCH", "amount": Sat, "valueUsdt": 2 * Sat, "confirmed": false, "createdAt": at}}, "runtime": M{"historyComplete": false}}
	report := telegramReport(state, now)
	text := s(report["text"])
	for _, part := range []string{"Net package spend: 0.00010100 BTC", "Net P&L: 0.00009900 BTC", "Net package spend: 4.00000000 USDT", "Net P&L: 2.00000000 USDT", "Pending value now: 2.00000000 USDT", "BTC: 0.00001000", "BCH: 1.00000000", "History incomplete/unverified"} {
		assert(t, strings.Contains(text, part), "Missing report amount %s: %s", part, text)
	}
}
func TestTelegramTestButtonAndTopic(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, M{"threadId": 42})
	assert(t, b(a.Telegram.Test(context.Background())["ok"]), "Telegram test failed")
	assert(t, n(tg.snapshot()[0]["message_thread_id"]) == 42, "Topic was ignored")
	assert(t, attempt(func() { a.Telegram.Test(context.Background()) }) != nil && len(tg.snapshot()) == 1, "Telegram tests were not throttled")
	a.Store.Set("telegramLastTest", nil)
	tg.set(403, 0)
	caught := attempt(func() { a.Telegram.Test(context.Background()) })
	assert(t, caught != nil && !strings.Contains(panicError(caught).Error(), telegramToken) && !strings.Contains(panicError(caught).Error(), telegramChat), "Test error leaked credentials")
}
func TestTelegramDisableCancelsQueuedMessages(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, nil)
	now := time.Now().Add(time.Second)
	addTelegramReceipt(a, "queued", now, nil)
	tg.set(429, 120)
	a.Telegram.Background(context.Background(), now)
	a.Telegram.Configure(M{"enabled": false})
	a.Telegram.Background(context.Background(), now.Add(time.Hour))
	assert(t, len(tg.snapshot()) == 1 && n(a.Telegram.Status()["pending"]) == 0, "Disabling Telegram did not stop queued delivery")
}

func TestTelegramPreferenceChangesAndManualDailyOverride(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, M{"dailyReports": true})
	now := time.Now().Add(time.Second)
	addTelegramReceipt(a, "off", now, nil)
	tg.set(429, 120)
	a.Telegram.Background(context.Background(), now)
	a.Telegram.Configure(M{"purchases": false, "dailyReports": false})
	a.Telegram.Background(context.Background(), now.Add(time.Minute))
	assert(t, len(tg.snapshot()) == 1, "Disabled notification category was delivered")
	tg.set(0, 0)
	result := a.Telegram.QueueReport(now.Add(2 * time.Minute))
	assert(t, b(result["queued"]), "Explicit report could not replace a cancelled scheduled report")
	a.Telegram.Background(context.Background(), now.Add(3*time.Minute))
	assert(t, len(tg.snapshot()) == 2, "Manual daily report did not send with automatic reports off")
}
func TestTelegramRejectedAndLostNiceHashResponsesAreNotSuccessAlerts(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(map[bool]string{false: "rejected", true: "lost response"}[timeout], func(t *testing.T) {
			a := testApp(t)
			nh := newProvider(t, a)
			tg := telegramMock(t, a)
			configureLive(a, false, false)
			enableTelegram(a, nil)
			nh.reject, nh.timeout = !timeout, timeout
			a.Engine.Tick(context.Background(), false)
			a.Telegram.Background(context.Background(), time.Now().Add(time.Second))
			assert(t, len(tg.snapshot()) == 0, "Unaccepted request sent a success alert")
			assert(t, len(maps(a.Store.List("orders")[0]["purchaseReceipts"])) == 0, "Rejected/uncertain request persisted an accepted receipt")
		})
	}
}
func TestTelegramPendingDeliverySurvivesFullStoreRestart(t *testing.T) {
	directory := t.TempDir()
	store := OpenStore(directory)
	first := NewTelegram(store)
	first.Configure(M{"enabled": true, "purchases": true, "dailyReports": false, "token": telegramToken, "chatId": telegramChat})
	c, credentials := first.config(), first.credentials()
	now := time.Now()
	first.enqueue("purchase:restart", "purchase", "Restart delivery fixture", telegramTarget(c, credentials), now)
	store.Close()
	reopened := OpenStore(directory)
	defer reopened.Close()
	a := &App{Store: reopened, Telegram: NewTelegram(reopened)}
	tg := telegramMock(t, a)
	assert(t, b(a.Telegram.Status()["enabled"]) && b(a.Telegram.Status()["configured"]), "Restart lost Telegram connection")
	a.Telegram.Background(context.Background(), now.Add(time.Second))
	assert(t, len(tg.snapshot()) == 1, "Restart lost pending notification")
}

func TestTelegramFullQueueStillDrains(t *testing.T) {
	a := testApp(t)
	tg := telegramMock(t, a)
	enableTelegram(a, nil)
	now := time.Now().Add(time.Second)
	target := telegramTarget(a.Telegram.config(), a.Telegram.credentials())
	a.Store.Batch(func(st *Store) {
		for i := 0; i < 500; i++ {
			id := fmt.Sprintf("full:%03d", i)
			row := M{"id": id, "kind": "purchase", "text": "Queue fixture", "target": target, "status": "PENDING", "attempts": 0, "createdAt": now.UTC().Format(time.RFC3339Nano), "nextAt": now.UTC().Format(time.RFC3339Nano)}
			st.Exec("INSERT INTO telegram_outbox(id,data) VALUES (?,?)", id, string(encode(row)))
		}
	})
	addTelegramReceipt(a, "new", now, nil)
	a.Telegram.Background(context.Background(), now)
	assert(t, len(tg.snapshot()) == 1 && n(a.Telegram.Status()["pending"]) == 499, "A full queue prevented existing delivery from draining")
}

func TestTelegramDeliveryCanRunDuringAccountSync(t *testing.T) {
	a := testApp(t)
	nh := newProvider(t, a)
	_ = nh
	tg := telegramMock(t, a)
	configureLive(a, false, false)
	enableTelegram(a, nil)
	a.Engine.Tick(context.Background(), false)
	now := time.Now().Add(time.Second)
	target := telegramTarget(a.Telegram.config(), a.Telegram.credentials())
	for i := 0; i < 20; i++ {
		a.Telegram.enqueue(fmt.Sprintf("concurrent:%d", i), "purchase", "Concurrent delivery fixture", target, now)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 20; i++ {
			a.Telegram.Background(context.Background(), now.Add(time.Duration(i)*time.Second))
		}
	}()
	for i := 0; i < 20; i++ {
		caught := attempt(func() { a.Engine.SyncNow(context.Background()) })
		assert(t, caught == nil, "Notification delivery interrupted account sync: %v", caught)
	}
	<-done
	assert(t, len(tg.snapshot()) > 0, "Concurrent notification worker never delivered")
}
