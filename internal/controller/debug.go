package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const debugTraceLimit = 50
const debugEventLimit = 100

type purchaseDebugKey struct{}
type purchaseDebugTrace struct {
	store                          *Store
	credentials                    M
	id, startedAt, source, outcome string
	started                        time.Time
	events                         []M
	requests, posts, dropped       int
	network                        bool
	redactions                     []string
}

func debugID(v any) any {
	if uuidRE.MatchString(s(v)) {
		return v
	}
	return nil
}
func debugFingerprint(v any) any {
	if s(v) == "" {
		return nil
	}
	d := sha256.Sum256([]byte("FastPool purchase debug reference\x00" + s(v)))
	return hex.EncodeToString(d[:])
}

var debugLongToken = regexp.MustCompile(`[A-Za-z0-9:._-]{24,}`)

func (t *purchaseDebugTrace) text(v any) string {
	if t == nil {
		return ""
	}
	return debugLongToken.ReplaceAllString(sanitize(s(v), t.credentials, t.redactions...), "[redacted-reference]")
}
func debugTrace(ctx context.Context) *purchaseDebugTrace {
	t, _ := ctx.Value(purchaseDebugKey{}).(*purchaseDebugTrace)
	return t
}
func debugStep(ctx context.Context, stage string, data M) {
	if t := debugTrace(ctx); t != nil {
		t.add(stage, data)
	}
}
func (t *purchaseDebugTrace) add(stage string, data M) {
	if len(t.events) >= debugEventLimit {
		t.dropped++
		return
	}
	t.events = append(t.events, M{"at": stamp(), "elapsedMs": time.Since(t.started).Milliseconds(), "stage": stage, "details": data})
}
func (t *purchaseDebugTrace) document() M {
	return M{"id": t.id, "source": t.source, "startedAt": t.startedAt, "updatedAt": stamp(), "elapsedMs": time.Since(t.started).Milliseconds(), "outcome": t.outcome, "requestCount": t.requests, "purchasePostCount": t.posts, "droppedEvents": t.dropped, "events": t.events}
}
func (t *purchaseDebugTrace) save() {
	// Observability must not change a submission's outcome, reservation or retry behavior.
	_ = attempt(func() {
		t.store.Batch(func(st *Store) {
			st.Exec("INSERT INTO purchase_debug(id,started_at,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", t.id, t.startedAt, string(encode(t.document())))
			st.Exec("DELETE FROM purchase_debug WHERE id NOT IN (SELECT id FROM purchase_debug ORDER BY started_at DESC,id DESC LIMIT ?)", debugTraceLimit)
		})
	})
}
func debugStatus(st *Store) M {
	cfg := obj(st.Get("purchaseDebug"))
	enabled := b(cfg["enabled"]) && time.Now().Before(parseTime(cfg["expiresAt"]))
	var count int
	must(st.q.QueryRow("SELECT COUNT(*) FROM purchase_debug").Scan(&count))
	return M{"enabled": enabled, "expiresAt": cfg["expiresAt"], "traceCount": count, "traceLimit": debugTraceLimit, "eventLimit": debugEventLimit}
}
func configurePurchaseDebug(st *Store, input M) M {
	enabled, ok := input["enabled"].(bool)
	check(ok, "Choose whether purchase debugging is enabled")
	cfg := M{"enabled": enabled, "expiresAt": nil}
	if enabled {
		minutes := first(input["minutes"], 60)
		check(integer(minutes) && contains([]string{"15", "60", "240"}, s(minutes)), "Choose a debug duration of 15, 60 or 240 minutes")
		cfg["expiresAt"] = time.Now().Add(time.Duration(n(minutes)) * time.Minute).UTC().Format(time.RFC3339Nano)
	}
	st.Set("purchaseDebug", cfg)
	return debugStatus(st)
}
func purchaseDebugReport(st *Store) M {
	rows, err := st.q.Query("SELECT data FROM purchase_debug ORDER BY started_at DESC,id DESC LIMIT ?", debugTraceLimit)
	must(err)
	defer rows.Close()
	traces := []M{}
	for rows.Next() {
		var data string
		must(rows.Scan(&data))
		traces = append(traces, obj(decode([]byte(data))))
	}
	must(rows.Err())
	must(rows.Close())
	return M{"kind": "fastpool-easymining-purchase-debug", "schemaVersion": 1, "version": Version, "exportedAt": stamp(), "status": debugStatus(st), "traces": traces, "units": "Payment amounts are integer 1e-8 units in the stated BTC or USDT market; outgoing request amounts are decimal payment currency. Coin rewards retain their own currency. Timing fields are milliseconds.", "note": "Captured during normal evaluations and manual purchases. Enabling, viewing, downloading or clearing debugging does not purchase, arm, start or retry. Credentials, authentication signatures, organization IDs, payout values, saved address IDs, 2FA and wallet balances are omitted. Request/response bodies are whitelisted summaries, not raw private responses. Reference fingerprints correlate selected payout records without exposing their values. Old failures cannot be reconstructed."}
}
func (e *Engine) beginPurchaseDebug(ctx context.Context, source string) (context.Context, func()) {
	if !b(debugStatus(e.Store)["enabled"]) {
		return ctx, func() {}
	}
	t := &purchaseDebugTrace{store: e.Store, credentials: e.Credentials(), id: uuid(), startedAt: stamp(), started: time.Now(), source: source, outcome: "running", events: []M{}}
	t.add("evaluation_started", M{"mode": obj(e.Store.Get("settings"))["mode"], "running": obj(e.Store.Get("settings"))["running"], "liveArmed": obj(e.Store.Get("settings"))["liveArmed"], "version": Version, "purchaseRequestProfile": purchaseProfile(obj(e.Store.Get("settings")))})
	return context.WithValue(ctx, purchaseDebugKey{}, t), func() {
		caught := recover()
		if caught != nil {
			t.outcome = "blocked-or-error"
			t.add("evaluation_error", M{"message": t.text(panicError(caught).Error()), "purchasePostCount": t.posts})
		}
		if t.outcome == "running" {
			t.outcome = "no-purchase"
		}
		t.add("evaluation_finished", M{"outcome": t.outcome, "purchasePostCount": t.posts})
		t.save()
		if caught != nil {
			panic(caught)
		}
	}
}
func debugDecision(ctx context.Context, st, q M, reason string) {
	t := debugTrace(ctx)
	if t == nil {
		return
	}
	for _, key := range []string{"payoutAddress", "mergePayoutAddress"} {
		if s(st[key]) != "" {
			t.redactions = append(t.redactions, s(st[key]))
		}
	}
	t.add("strategy_decision", M{"strategyId": debugID(st["id"]), "coin": st["coin"], "selection": map[bool]string{true: "levels", false: "ordinary"}[levelBuying(st)], "eligible": reason == "", "reason": t.text(strfirst(reason, "Ready to buy")), "team": debugTeam(t, q), "market": paymentMarket(st), "additionalAmount": moneyValue(q, "costBtc"), "additionalCostBtc": q["costBtc"], "additionalShares": first(q["shares"], st["shares"]), "level": pick(obj(q["teamLevel"]), []string{"threshold", "shares"}), "priorOrderId": debugID(q["parentOrderId"])})
}
func debugTeam(t *purchaseDebugTrace, q M) M {
	if q == nil {
		return nil
	}
	return debugSafeSnapshot(t, teamSnapshot(q))
}
func debugSafeSnapshot(t *purchaseDebugTrace, snapshot M) M {
	if len(snapshot) == 0 {
		return nil
	}
	r := clone(snapshot)
	for _, k := range []string{"name", "coin", "mergeCoin", "market", "status", "state"} {
		r[k] = t.text(r[k])
	}
	r["id"] = debugID(r["id"])
	return r
}
func debugPurchaseResult(ctx context.Context, order M) {
	t := debugTrace(ctx)
	if t == nil {
		return
	}
	t.outcome = map[string]string{"FAILED": "rejected", "UNKNOWN": "uncertain", "ACTIVE": "accepted", "PENDING": "accepted", "COMPLETED": "accepted"}[s(order["status"])]
	if s(obj(order["lastTeamPurchaseFailure"])["debugTraceId"]) == t.id {
		t.outcome = "rejected-addition-prior-holding-retained"
	}
	if s(order["mode"]) == "paper" {
		t.outcome = "simulated"
	}
	t.add("purchase_result", pick(order, []string{"id", "requestId", "mode", "market", "status", "costBtc", "costAmount", "feeBtc", "feeAmount", "shares", "debugTraceId", "purchaseRequestProfile"}))
}

func debugRequestBody(t *purchaseDebugTrace, raw M) M {
	out := pick(raw, []string{"amount", "shares", "clear", "ticketId", "buyWithCurrency"})
	for _, k := range []string{"soloMiningRewardAddr", "mergeSoloMiningRewardAddr", "soloMiningRewardWithdrawalAddrId", "mergeSoloMiningRewardWithdrawalAddrId"} {
		if s(raw[k]) != "" {
			t.redactions = append(t.redactions, s(raw[k]))
			out[k] = M{"redacted": true, "fingerprint": debugFingerprint(raw[k])}
		}
	}
	return out
}
func debugResponseSummary(t *purchaseDebugTrace, path string, parsed any) M {
	root := obj(parsed)
	out := M{}
	keys := []string{}
	for k := range root {
		if regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`).MatchString(k) {
			keys = append(keys, t.text(k))
		}
	}
	sort.Strings(keys)
	if len(keys) > 40 {
		keys = keys[:40]
	}
	out["fieldNames"] = keys
	errors := maps(root["errors"])
	if root["error"] != nil {
		errors = append(errors, obj(root["error"]))
		if text, ok := root["error"].(string); ok {
			out["errorMessage"] = t.text(text)
		}
	}
	if len(errors) > 0 {
		safe := []M{}
		for i, r := range errors {
			if i == 5 {
				break
			}
			safe = append(safe, M{"code": t.text(r["code"]), "message": t.text(r["message"])})
		}
		out["errors"] = safe
	}
	if uuidRE.MatchString(s(root["error_id"])) {
		out["providerErrorId"] = root["error_id"]
	}
	if strings.Contains(path, "/shared/ticket/") || strings.HasSuffix(path, "/hashpower/solo/order") {
		out["id"] = debugID(root["id"])
		if _, ok := root["success"].(bool); ok {
			out["success"] = root["success"]
		}
		if regexp.MustCompile(`^[A-Z_]{1,40}$`).MatchString(s(root["successType"])) {
			out["successType"] = root["successType"]
		}
		out["status"] = t.text(status(root["status"]))
	}
	if strings.HasSuffix(path, "/sharedTicketExternalAddress/list") {
		addresses := []M{}
		for i, a := range maps(parsed) {
			if i == 50 {
				break
			}
			row := M{"idFingerprint": debugFingerprint(a["id"]), "organizationFieldPresent": s(a["organizationId"]) != "", "organizationMatchesConfigured": strings.EqualFold(s(a["organizationId"]), s(t.credentials["orgId"]))}
			if coinRE.MatchString(s(a["currency"])) {
				row["coin"] = a["currency"]
			}
			addresses = append(addresses, row)
		}
		out["savedAddressCount"] = len(maps(parsed))
		out["savedAddresses"] = addresses
	}
	if strings.Contains(path, "/solo/shared/order/") {
		member, ownership := membership(root, s(t.credentials["orgId"]))
		out["id"] = debugID(root["id"])
		out["membership"] = ownership
		out["status"] = t.text(status(root["status"]))
		shares := M{}
		for _, k := range []string{"small", "medium", "large", "couponSmall", "couponMedium", "couponLarge", "massBuy"} {
			if integer(obj(member["shares"])[k]) {
				shares[k] = obj(member["shares"])[k]
			}
		}
		out["personalShares"] = shares
	}
	if list, ok := root["list"].([]any); ok {
		out["returnedRows"] = len(list)
	}
	return out
}

// The callback observes only the existing HTTP exchange; it never makes a request.
func beginDebugRequest(ctx context.Context, req *http.Request, path string, query url.Values, body []byte, offset int64) (done func(*http.Response, any, error)) {
	done = func(*http.Response, any, error) {}
	defer func() {
		if recover() != nil {
			done = func(*http.Response, any, error) {}
		}
	}()
	t := debugTrace(ctx)
	if t == nil || !t.network {
		return done
	}
	t.requests++
	requestNumber := t.requests
	if req.Method == "POST" {
		t.posts++
	}
	for _, k := range []string{"X-Twofa-Token", "X-Otp-Token"} {
		if req.Header.Get(k) != "" {
			t.redactions = append(t.redactions, req.Header.Get(k))
		}
	}
	details := M{"number": requestNumber, "method": req.Method, "baseUrl": req.URL.Scheme + "://" + req.URL.Host, "path": path, "clockOffsetMs": offset, "requestId": req.Header.Get("X-Request-Id"), "headers": M{"Content-Type": req.Header.Get("Content-Type"), "Accept": req.Header.Get("Accept"), "User-Agent": req.Header.Get("User-Agent"), "X-Time": req.Header.Get("X-Time"), "X-Nonce": req.Header.Get("X-Nonce"), "authenticationPresent": req.Header.Get("X-Auth") != "", "organizationHeaderPresent": req.Header.Get("X-Organization-Id") != "", "twofaHeaderPresent": req.Header.Get("X-Twofa-Token") != ""}}
	if len(query) > 0 {
		safe := url.Values{}
		for _, k := range []string{"page", "limit", "onlyGold", "currency"} {
			if query.Get(k) != "" {
				safe.Set(k, query.Get(k))
			}
		}
		details["query"] = safe.Encode()
	}
	if len(body) > 0 {
		digest := sha256.Sum256(body)
		details["bodyBytes"] = len(body)
		details["bodySHA256"] = hex.EncodeToString(digest[:])
		details["body"] = debugRequestBody(t, obj(decode(body)))
	}
	t.add("http_request", details)
	// Persist before the existing network call so a hung/interrupted request is visible.
	t.save()
	started := time.Now()
	return func(resp *http.Response, parsed any, err error) {
		_ = attempt(func() {
			row := M{"number": requestNumber, "method": req.Method, "path": path, "durationMs": time.Since(started).Milliseconds(), "requestId": req.Header.Get("X-Request-Id")}
			if resp != nil {
				row["httpStatus"] = resp.StatusCode
				row["contentType"] = t.text(resp.Header.Get("Content-Type"))
				row["retryAfter"] = t.text(resp.Header.Get("Retry-After"))
			}
			if parsed != nil {
				if attempt(func() { row["summary"] = debugResponseSummary(t, path, parsed) }) != nil {
					row["summaryUnavailable"] = true
				}
			}
			if err != nil {
				row["transportOrDecodeError"] = t.text(err.Error())
			}
			t.add("http_response", row)
			t.save()
		})
	}
}
