package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Telegram never owns the buying lease or calls NiceHash. Only persisted,
// accepted purchase receipts are observed by this independent worker.
type Telegram struct {
	Store *Store
	HTTP  *http.Client
	mu    sync.Mutex
}

func NewTelegram(st *Store) *Telegram {
	return &Telegram{Store: st, HTTP: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func telegramDefaults() M {
	return M{"enabled": false, "purchases": true, "dailyReports": true, "reportTime": "00:05", "threadId": int64(0)}
}
func (t *Telegram) config() M { return merge(telegramDefaults(), obj(t.Store.Get("telegramOptions"))) }
func (t *Telegram) credentials() M {
	if v := s(t.Store.Get("telegramCredentials")); v != "" {
		return t.Store.Unseal(v)
	}
	return M{}
}
func telegramTarget(c, credentials M) string {
	sum := sha256.Sum256([]byte(s(credentials["chatId"]) + "\x00" + s(c["threadId"])))
	return hex.EncodeToString(sum[:12])
}
func (t *Telegram) Status() M {
	c := t.config()
	credentials := t.credentials()
	status := obj(t.Store.Get("telegramStatus"))
	masked := ""
	id := s(credentials["chatId"])
	if id != "" {
		tail := id
		if len(tail) > 4 {
			tail = tail[len(tail)-4:]
		}
		masked = "Saved chat · ••••" + tail
	}
	var pending, failed int64
	must(t.Store.q.QueryRow(`SELECT COALESCE(SUM(CASE WHEN json_extract(data,'$.status') IN ('PENDING','RETRY','SENDING') THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN json_extract(data,'$.status')='FAILED' THEN 1 ELSE 0 END),0) FROM telegram_outbox`).Scan(&pending, &failed))
	return merge(pick(c, []string{"enabled", "purchases", "dailyReports", "reportTime", "threadId"}), pick(status, []string{"lastSentAt", "lastError", "lastErrorAt", "nextAttemptAt", "lastDailyDate"}), M{"supported": true, "configured": s(credentials["token"]) != "" && id != "", "tokenConfigured": s(credentials["token"]) != "", "chatLabel": masked, "pending": pending, "failed": failed, "timezone": obj(t.Store.Get("settings"))["timezone"]})
}
func (t *Telegram) Configure(input M) M {
	t.mu.Lock()
	defer t.mu.Unlock()
	old := t.config()
	c := merge(old)
	credentials := t.credentials()
	oldCredentials := clone(credentials)
	if b(input["clear"]) {
		credentials = M{}
		c["enabled"] = false
	} else {
		for _, key := range []string{"enabled", "purchases", "dailyReports"} {
			if has(input, key) {
				_, ok := input[key].(bool)
				check(ok, "Telegram "+key+" must be true or false")
				c[key] = input[key]
			}
		}
		if has(input, "reportTime") {
			check(timeRE.MatchString(s(input["reportTime"])), "Choose a valid Telegram report time")
			c["reportTime"] = input["reportTime"]
		}
		if has(input, "threadId") {
			check(integer(input["threadId"]) && n(input["threadId"]) >= 0, "Telegram topic ID must be a nonnegative integer")
			c["threadId"] = n(input["threadId"])
		}
		if token := strings.TrimSpace(s(input["token"])); token != "" {
			check(regexp.MustCompile(`^[0-9]{5,20}:[A-Za-z0-9_-]{20,200}$`).MatchString(token), "Enter the complete bot token from BotFather")
			credentials["token"] = token
		}
		if chat := strings.TrimSpace(s(input["chatId"])); chat != "" {
			check(regexp.MustCompile(`^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$`).MatchString(chat), "Enter a numeric chat ID or @channel username")
			credentials["chatId"] = chat
		}
	}
	check(!b(c["enabled"]) || (s(credentials["token"]) != "" && s(credentials["chatId"]) != ""), "Save a bot token and chat ID before enabling Telegram")
	changed := string(encode(credentials)) != string(encode(oldCredentials)) || n(c["threadId"]) != n(old["threadId"])
	if (!b(old["enabled"]) && b(c["enabled"])) || (!b(old["purchases"]) && b(c["purchases"])) || changed {
		c["purchaseSince"] = stamp()
	}
	target := telegramTarget(c, credentials)
	t.Store.Batch(func(st *Store) {
		st.Set("telegramOptions", c)
		if len(credentials) == 0 {
			st.Set("telegramCredentials", nil)
		} else {
			st.Set("telegramCredentials", st.Seal(credentials))
		}
		if !b(c["enabled"]) || changed {
			st.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.status','CANCELLED') WHERE json_extract(data,'$.status') IN ('PENDING','RETRY','SENDING')`)
		}
		if !b(c["purchases"]) {
			st.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.status','CANCELLED') WHERE json_extract(data,'$.kind')='purchase' AND json_extract(data,'$.status') IN ('PENDING','RETRY')`)
		}
		if !b(c["dailyReports"]) {
			st.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.status','CANCELLED') WHERE json_extract(data,'$.kind')='daily' AND COALESCE(json_extract(data,'$.manual'),0)=0 AND json_extract(data,'$.status') IN ('PENDING','RETRY')`)
		}
		if b(c["enabled"]) {
			st.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.status','RETRY','$.nextAt',?,'$.attempts',0) WHERE json_extract(data,'$.status')='FAILED' AND json_extract(data,'$.target')=? AND julianday(json_extract(data,'$.createdAt'))>=julianday(?)`, stamp(), target, time.Now().Add(-24*time.Hour).UTC().Format(time.RFC3339Nano))
		}
		st.Set("telegramStatus", merge(obj(st.Get("telegramStatus")), M{"lastError": nil, "nextAttemptAt": nil}))
		st.Event("info", map[bool]string{true: "Telegram notifications enabled", false: "Telegram notifications disabled"}[b(c["enabled"])])
	})
	return t.Status()
}

func notificationLabel(value any) string {
	r := []rune(strings.Join(strings.Fields(s(value)), " "))
	if len(r) > 120 {
		r = r[:120]
	}
	return string(r)
}
func telegramPurchaseText(order, receipt, strategy M, zone string) string {
	loc, err := time.LoadLocation(zone)
	if err != nil {
		loc = time.UTC
		zone = "UTC"
	}
	label := notificationLabel(strategy["name"])
	if label == "" {
		label = "Manual web purchase"
	}
	market := paymentMarket(order)
	text := fmt.Sprintf("FastPool EasyMining — purchase accepted\n%s · %s rewards\nStrategy: %s\nPayment: %s %s\n", notificationLabel(order["name"]), notificationLabel(order["coin"]), label, decimal(n(receipt["amount"])), market)
	if s(order["kind"]) == "team" {
		text += fmt.Sprintf("Shares added: %d · total owned: %d\nTeam commitment: %s %s\n", n(receipt["shares"]), n(receipt["totalShares"]), decimal(n(receipt["totalAmount"])), market)
		if receipt["threshold"] != nil {
			text += fmt.Sprintf("Buying level: %d joined shares\n", n(receipt["threshold"]))
		}
	}
	text += "Time: " + parseTime(receipt["at"]).In(loc).Format("02 Jan 2006 15:04:05") + " · " + zone + "\nOrder: " + notificationLabel(first(order["externalId"], order["id"])) + "\nReference: " + notificationLabel(receipt["requestId"])
	if s(order["kind"]) == "team" {
		text += "\nAccepted by NiceHash; membership details may still be syncing."
	}
	return text
}
func telegramReport(state M, now time.Time) M {
	zone := strfirst(obj(state["settings"])["timezone"], "Europe/Sofia")
	loc, err := time.LoadLocation(zone)
	must(err)
	local := now.In(loc)
	end := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).Add(-time.Nanosecond)
	day := end.In(loc).Format("2006-01-02")
	rates := obj(obj(state["runtime"])["exchangeRates"])
	orders, rewards := maps(state["orders"]), maps(state["rewards"])
	text := "FastPool EasyMining — daily report\n" + day + " · " + zone + "\nLive account ledger · valuation estimates\n"
	ids := map[string]bool{}
	for _, o := range orders {
		if s(o["mode"]) == "live" && accounted(o) {
			ids[s(o["id"])] = true
		}
	}
	coins := map[string]int64{}
	for _, r := range rewards {
		if ids[s(r["orderId"])] && rewardAccounted(r) && b(r["confirmed"]) && parseTime(first(r["confirmedAt"], r["createdAt"])).In(loc).Format("2006-01-02") == day {
			coins[s(r["coin"])] += n(r["amount"])
		}
	}
	for _, market := range []string{"BTC", "USDT"} {
		report := dailyReport(orders, rewards, "live", zone, 1, end, rates, market)
		row := maps(report["rows"])[0]
		pending := totals(orders, rewards, "live", market)
		text += fmt.Sprintf("\n%s ledger\nPurchases: %d\nNet package spend: %s %s\nConfirmed reward value: %s %s\nNet P&L: %s %s\nPending value now: %s %s\n", market, n(row["purchases"]), decimal(n(row["spend"])), market, decimal(n(row["earned"])), market, decimal(n(row["net"])), market, decimal(n(pending["pending"])), market)
		usd, eur := fiatValue(n(row["net"]), market, "USD", rates), fiatValue(n(row["net"]), market, "EUR", rates)
		if usd != nil && eur != nil {
			text += fmt.Sprintf("Net spot estimate: $%.2f / €%.2f\n", f(usd), f(eur))
		} else {
			text += "Net USD/EUR estimate unavailable (missing rates).\n"
		}
		if n(row["unpriced"]) > 0 {
			text += fmt.Sprintf("Confirmed rewards without %s valuation: %d (excluded)\n", market, n(row["unpriced"]))
		}
	}
	text += "\nPersonal coin rewards confirmed that day\n"
	ordered := []string{"BTC", "BCH", "LTC", "DOGE", "ZEC"}
	extra := []string{}
	for coin := range coins {
		if !contains(ordered, coin) {
			extra = append(extra, coin)
		}
	}
	sort.Strings(extra)
	ordered = append(ordered, extra...)
	for _, coin := range ordered {
		text += coin + ": " + decimal(coins[coin]) + "\n"
	}
	rt := obj(state["runtime"])
	if !b(rt["historyComplete"]) {
		text += "\nHistory incomplete/unverified: this report can be partial.\n"
	} else if last := parseTime(rt["lastSync"]); last.IsZero() || now.Sub(last) > 15*time.Minute {
		text += "\nAccount sync is stale or unavailable; totals reflect the saved ledger only.\n"
	}
	text += "\nConfirmation dates are first observed dates. Pending rewards are excluded from P&L. Fiat figures use current spot estimates; no coins are exchanged."
	if rates["at"] != nil {
		text += "\nRates: " + s(rates["at"])
	}
	if rt["lastSync"] != nil {
		text += "\nLast account sync: " + s(rt["lastSync"])
	}
	return M{"date": day, "timezone": zone, "text": text}
}
func (t *Telegram) Report(now time.Time) M {
	var state M
	t.Store.Batch(func(st *Store) {
		state = M{"settings": st.Get("settings"), "orders": st.List("orders"), "rewards": st.List("rewards"), "runtime": st.Get("runtime")}
	})
	return telegramReport(state, now)
}
func (t *Telegram) enqueue(id, kind, text, target string, now time.Time) bool {
	var exists int
	must(t.Store.q.QueryRow("SELECT COUNT(*) FROM telegram_outbox WHERE id=?", id).Scan(&exists))
	if exists > 0 {
		return false
	}
	var count int
	must(t.Store.q.QueryRow(`SELECT COUNT(*) FROM telegram_outbox WHERE json_extract(data,'$.status') IN ('PENDING','RETRY','SENDING')`).Scan(&count))
	if count >= 500 {
		t.Store.Set("telegramStatus", merge(obj(t.Store.Get("telegramStatus")), M{"lastError": "Telegram queue is full; queued messages are processed before more can be added", "lastErrorAt": stamp()}))
		return false
	}
	row := M{"id": id, "kind": kind, "text": text, "target": target, "createdAt": now.UTC().Format(time.RFC3339Nano), "nextAt": now.UTC().Format(time.RFC3339Nano), "status": "PENDING", "attempts": 0}
	result, err := t.Store.q.Exec("INSERT OR IGNORE INTO telegram_outbox(id,data) VALUES (?,?)", id, string(encode(row)))
	must(err)
	n, err := result.RowsAffected()
	must(err)
	return n > 0
}
func (t *Telegram) queuePurchases(c, credentials M, now time.Time) {
	since := parseTime(c["purchaseSince"])
	if since.IsZero() {
		return
	}
	if since.Before(now.Add(-24 * time.Hour)) {
		since = now.Add(-24 * time.Hour)
	}
	rows, err := t.Store.q.Query(`SELECT o.data,r.value FROM orders o,json_each(o.data,'$.purchaseReceipts') r LEFT JOIN telegram_outbox q ON q.id='purchase:'||json_extract(r.value,'$.requestId') WHERE q.id IS NULL AND json_extract(o.data,'$.mode')='live' AND julianday(json_extract(r.value,'$.at'))>=julianday(?) LIMIT 50`, since.UTC().Format(time.RFC3339Nano))
	must(err)
	pairs := [][2]M{}
	for rows.Next() {
		var order, receipt string
		must(rows.Scan(&order, &receipt))
		pairs = append(pairs, [2]M{obj(decode([]byte(order))), obj(decode([]byte(receipt)))})
	}
	must(rows.Err())
	must(rows.Close())
	strategies := t.Store.List("strategies")
	zone := s(obj(t.Store.Get("settings"))["timezone"])
	for _, pair := range pairs {
		o, r := pair[0], pair[1]
		if parseTime(r["at"]).Before(since) || !current(o) || contains([]string{"FAILED", "REJECTED", "UNKNOWN", "SUBMITTING"}, s(o["status"])) {
			continue
		}
		if !t.enqueue("purchase:"+s(r["requestId"]), "purchase", telegramPurchaseText(o, r, findBy(strategies, "id", o["strategyId"]), zone), telegramTarget(c, credentials), now) {
			break
		}
	}
}
func (t *Telegram) queueDaily(c, credentials M, now time.Time, manual bool) bool {
	zone := s(obj(t.Store.Get("settings"))["timezone"])
	loc, err := time.LoadLocation(zone)
	must(err)
	day := now.In(loc).AddDate(0, 0, -1).Format("2006-01-02")
	key := "daily:" + telegramTarget(c, credentials) + ":" + zone + ":" + day
	var existing string
	err = t.Store.q.QueryRow("SELECT data FROM telegram_outbox WHERE id=?", key).Scan(&existing)
	if err != nil && err != sql.ErrNoRows {
		must(err)
	}
	if existing != "" {
		row := obj(decode([]byte(existing)))
		if s(row["status"]) != "CANCELLED" && !(manual && s(row["status"]) == "FAILED") {
			return false
		}
		report := t.Report(now)
		row = merge(row, M{"text": report["text"], "status": "PENDING", "attempts": 0, "manual": manual, "createdAt": now.UTC().Format(time.RFC3339Nano), "nextAt": now.UTC().Format(time.RFC3339Nano)})
		t.Store.Exec("UPDATE telegram_outbox SET data=? WHERE id=?", string(encode(row)), key)
		return true
	}
	report := t.Report(now)
	id := "daily:" + telegramTarget(c, credentials) + ":" + s(report["timezone"]) + ":" + s(report["date"])
	queued := t.enqueue(id, "daily", s(report["text"]), telegramTarget(c, credentials), now)
	if queued && manual {
		t.Store.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.manual',json('true')) WHERE id=?`, id)
	}
	return queued
}
func (t *Telegram) QueueReport(now time.Time) M {
	t.mu.Lock()
	defer t.mu.Unlock()
	c, credentials := t.config(), t.credentials()
	check(b(c["enabled"]) && s(credentials["token"]) != "" && s(credentials["chatId"]) != "", "Enable and configure Telegram first")
	var pending int
	must(t.Store.q.QueryRow(`SELECT COUNT(*) FROM telegram_outbox WHERE json_extract(data,'$.status') IN ('PENDING','RETRY','SENDING')`).Scan(&pending))
	check(pending < 500, "Telegram queue is full. Wait for existing notifications to finish.")
	queued := t.queueDaily(c, credentials, now, true)
	return M{"queued": queued, "message": map[bool]string{true: "Daily report queued", false: "This daily report is already queued or sent"}[queued]}
}

type telegramResult struct {
	ok, retry bool
	delay     time.Duration
	message   string
}

func (t *Telegram) send(ctx context.Context, c, credentials M, text string) telegramResult {
	payload := M{"chat_id": credentials["chatId"], "text": text, "link_preview_options": M{"is_disabled": true}}
	if n(c["threadId"]) > 0 {
		payload["message_thread_id"] = n(c["threadId"])
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", "https://api.telegram.org/bot"+s(credentials["token"])+"/sendMessage", bytes.NewReader(encode(payload)))
	if err != nil {
		return telegramResult{message: "Telegram request could not be created"}
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := t.HTTP.Do(request)
	if err != nil {
		return telegramResult{retry: true, message: "Telegram delivery could not be confirmed; a notification retry is scheduled"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 {
		return telegramResult{retry: true, message: "Telegram returned an unreadable response"}
	}
	var raw M
	caught := attempt(func() { raw = obj(decode(data)) })
	if caught != nil {
		return telegramResult{retry: true, message: "Telegram returned an invalid response"}
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 && b(raw["ok"]) && integer(obj(raw["result"])["message_id"]) {
		return telegramResult{ok: true}
	}
	code := n(first(raw["error_code"], response.StatusCode))
	message := "Telegram rejected the message. Check the bot token, chat ID and topic."
	switch code {
	case 401, 404:
		message = "Telegram rejected the bot token. Check the saved token."
	case 400:
		message = "Telegram rejected the chat or topic. Start the bot and check its chat ID and permissions."
	case 403:
		message = "The Telegram bot is blocked or cannot post to this chat."
	case 429:
		message = "Telegram rate limit reached; delivery will retry after the requested delay."
	}
	delay := time.Duration(n(obj(raw["parameters"])["retry_after"])) * time.Second
	if delay < 0 || delay > 7*24*time.Hour {
		delay = 0
	}
	return telegramResult{retry: code == 429 || code >= 500, delay: delay, message: message}
}
func (t *Telegram) Test(ctx context.Context) M {
	t.mu.Lock()
	defer t.mu.Unlock()
	c, credentials := t.config(), t.credentials()
	check(s(credentials["token"]) != "" && s(credentials["chatId"]) != "", "Save a bot token and chat ID first")
	last := parseTime(t.Store.Get("telegramLastTest"))
	check(last.IsZero() || time.Since(last) >= 30*time.Second, "Wait 30 seconds between Telegram tests")
	t.Store.Set("telegramLastTest", stamp())
	result := t.send(ctx, c, credentials, "FastPool EasyMining "+Version+" — Telegram test\nConnection is working. Purchase alerts cover live purchases accepted through this application. Daily reports use "+s(obj(t.Store.Get("settings"))["timezone"])+".")
	if !result.ok {
		t.Store.Set("telegramStatus", merge(obj(t.Store.Get("telegramStatus")), M{"lastError": result.message, "lastErrorAt": stamp()}))
		fail(result.message)
	}
	t.Store.Set("telegramStatus", merge(obj(t.Store.Get("telegramStatus")), M{"lastSentAt": stamp(), "lastError": nil}))
	return M{"ok": true}
}
func (t *Telegram) deliver(ctx context.Context, c, credentials M, now time.Time) {
	status := obj(t.Store.Get("telegramStatus"))
	if now.Before(parseTime(status["nextAttemptAt"])) {
		return
	}
	t.Store.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.status','RETRY','$.nextAt',?) WHERE json_extract(data,'$.status')='SENDING' AND julianday(json_extract(data,'$.attemptedAt'))<julianday(?)`, now.UTC().Format(time.RFC3339Nano), now.Add(-30*time.Second).UTC().Format(time.RFC3339Nano))
	rows, err := t.Store.q.Query(`SELECT data FROM telegram_outbox WHERE json_extract(data,'$.status') IN ('PENDING','RETRY') AND julianday(json_extract(data,'$.nextAt'))<=julianday(?) ORDER BY json_extract(data,'$.createdAt'),id LIMIT 1`, now.UTC().Format(time.RFC3339Nano))
	must(err)
	var row M
	if rows.Next() {
		var data string
		must(rows.Scan(&data))
		row = obj(decode([]byte(data)))
	}
	must(rows.Err())
	must(rows.Close())
	if row == nil {
		return
	}
	if s(row["target"]) != telegramTarget(c, credentials) || now.Sub(parseTime(row["createdAt"])) > 24*time.Hour {
		row["status"] = "CANCELLED"
		t.Store.Exec("UPDATE telegram_outbox SET data=? WHERE id=?", string(encode(row)), row["id"])
		return
	}
	result, err := t.Store.q.Exec(`UPDATE telegram_outbox SET data=json_set(data,'$.status','SENDING','$.attemptedAt',?) WHERE id=? AND json_extract(data,'$.status') IN ('PENDING','RETRY')`, now.UTC().Format(time.RFC3339Nano), row["id"])
	must(err)
	changed, err := result.RowsAffected()
	must(err)
	if changed != 1 {
		return
	}
	outcome := t.send(ctx, c, credentials, s(row["text"]))
	row["attempts"] = n(row["attempts"]) + 1
	if outcome.ok {
		row["status"] = "SENT"
		row["sentAt"] = stamp()
		status["lastSentAt"] = stamp()
		status["lastError"], status["nextAttemptAt"] = nil, nil
		if s(row["kind"]) == "daily" {
			status["lastDailyDate"] = strings.Split(s(row["id"]), ":")[3]
		}
	} else {
		row["status"] = "FAILED"
		row["lastError"] = outcome.message
		status["lastError"], status["lastErrorAt"] = outcome.message, stamp()
		if outcome.retry && n(row["attempts"]) < 8 {
			row["status"] = "RETRY"
			delay := 30 * time.Second * time.Duration(1<<uint(n(row["attempts"])-1))
			if delay > 30*time.Minute {
				delay = 30 * time.Minute
			}
			if outcome.delay > delay {
				delay = outcome.delay
			}
			row["nextAt"] = now.Add(delay).UTC().Format(time.RFC3339Nano)
			status["nextAttemptAt"] = row["nextAt"]
		}
	}
	t.Store.Batch(func(st *Store) {
		st.Exec("UPDATE telegram_outbox SET data=? WHERE id=?", string(encode(row)), row["id"])
		st.Set("telegramStatus", status)
	})
}
func (t *Telegram) Background(ctx context.Context, now time.Time) {
	if !t.mu.TryLock() {
		return
	}
	defer t.mu.Unlock()
	defer func() {
		if recover() != nil {
			attempt(func() {
				t.Store.Set("telegramStatus", merge(obj(t.Store.Get("telegramStatus")), M{"lastError": "Telegram notification processing failed; the buying engine is unaffected", "lastErrorAt": stamp()}))
			})
		}
	}()
	c, credentials := t.config(), t.credentials()
	if !b(c["enabled"]) || s(credentials["token"]) == "" || s(credentials["chatId"]) == "" {
		return
	}
	if b(c["purchases"]) {
		t.queuePurchases(c, credentials, now)
	}
	if b(c["dailyReports"]) {
		loc, err := time.LoadLocation(s(obj(t.Store.Get("settings"))["timezone"]))
		must(err)
		if now.In(loc).Format("15:04") >= s(c["reportTime"]) {
			t.queueDaily(c, credentials, now, false)
		}
	}
	t.deliver(ctx, c, credentials, now)
	t.Store.Exec(`DELETE FROM telegram_outbox WHERE julianday(json_extract(data,'$.createdAt'))<julianday(?) AND json_extract(data,'$.status')!='SENDING'`, now.AddDate(0, 0, -7).UTC().Format(time.RFC3339Nano))
}
