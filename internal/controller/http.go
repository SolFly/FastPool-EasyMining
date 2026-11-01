package controller

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"golang.org/x/crypto/scrypt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Options struct {
	DataDir, PublicURL, Password string
	Assets                       fs.FS
	ServerCredentials            M
	ServerSource, ConfigError    string
}
type loginAttempt struct {
	count int
	until time.Time
}
type App struct {
	Store      *Store
	Engine     *Engine
	Telegram   *Telegram
	Options    Options
	setupToken string
	authMu     sync.Mutex
	attempts   map[string]loginAttempt
}

func NewApp(options Options) *App {
	st := OpenStore(options.DataDir)
	st.SnapshotBeforeGo()
	a := &App{Store: st, Options: options, attempts: map[string]loginAttempt{}}
	a.migrateContinuousBuying()
	if st.Get("credentialSource") == nil {
		source := "none"
		if st.Get("credentials") != nil {
			source = "web"
		} else if options.ServerCredentials != nil {
			source = "server"
		}
		st.Set("credentialSource", source)
	}
	a.Engine = &Engine{Store: st, Credentials: a.Credentials}
	a.Telegram = NewTelegram(st)
	a.Engine.repairRejected()
	for _, o := range st.List("orders") {
		if current(o) && s(o["mode"]) == "live" && s(o["kind"]) == "solo" && automatic(o) && n(obj(o["attribution"])["version"]) != 1 {
			o["attribution"] = M{"state": "review", "version": 1, "at": stamp(), "reason": "Checking imported purchase ownership after the Go migration"}
			st.Save("orders", o)
		}
	}
	if st.Get("admin") == nil {
		if options.Password != "" {
			check(len(options.Password) >= 12, "APP_PASSWORD must have at least 12 characters")
			st.Set("admin", passwordHash(options.Password))
		} else {
			a.setupToken = randomHex(24)
		}
	}
	return a
}
func (a *App) SetupToken() string { return a.setupToken }
func (a *App) Credentials() M {
	switch s(a.Store.Get("credentialSource")) {
	case "server":
		return a.Options.ServerCredentials
	case "web":
		if sealed := s(a.Store.Get("credentials")); sealed != "" {
			return a.Store.Unseal(sealed)
		}
	}
	return M{}
}
func (a *App) Connection() M {
	c := a.Credentials()
	return M{"configured": s(c["key"]) != "", "verified": s(c["key"]) != "" && b(a.Store.Get("verified")), "organizationId": strfirst(c["orgId"], ""), "baseUrl": strfirst(c["baseUrl"], BaseURL), "source": a.Store.Get("credentialSource"), "serverAvailable": a.Options.ServerCredentials != nil, "serverSource": a.Options.ServerSource, "serverConfigError": a.Options.ConfigError}
}
func (a *App) State() M {
	return merge(a.Store.State(), M{"connection": a.Connection(), "telegram": a.Telegram.Status(), "version": Version, "runtimeLanguage": "Go", "paymentMarkets": []string{"BTC", "USDT"}, "purchaseDebug": debugStatus(a.Store), "purchaseRequestProfiles": purchaseProfiles()})
}
func randomHex(size int) string {
	raw := make([]byte, size)
	_, e := rand.Read(raw)
	must(e)
	return hex.EncodeToString(raw)
}
func passwordHash(password string) M {
	salt := randomHex(16)
	hash, e := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 64)
	must(e)
	return M{"salt": salt, "hash": hex.EncodeToString(hash)}
}
func (a *App) checkPassword(password any) bool {
	text, ok := password.(string)
	if !ok || len(text) > 4096 {
		return false
	}
	admin := obj(a.Store.Get("admin"))
	if len(admin) == 0 {
		return false
	}
	expected, err := hex.DecodeString(s(admin["hash"]))
	if err != nil || len(expected) != 64 {
		return false
	}
	actual, err := scrypt.Key([]byte(text), []byte(s(admin["salt"])), 16384, 8, 1, 64)
	must(err)
	return subtle.ConstantTimeCompare(expected, actual) == 1
}
func cookieHash(v string) string {
	digest := sha256.Sum256([]byte(v))
	return hex.EncodeToString(digest[:])
}
func (a *App) authorized(r *http.Request) bool {
	cookie, err := r.Cookie("fp_session")
	if err != nil {
		return false
	}
	var count int
	must(a.Store.q.QueryRow("SELECT COUNT(*) FROM sessions WHERE token=? AND expires>?", cookieHash(cookie.Value), time.Now().UnixMilli()).Scan(&count))
	return count == 1
}
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	token := randomHex(32)
	a.Store.Exec("INSERT INTO sessions(token,expires) VALUES (?,?)", cookieHash(token), time.Now().Add(12*time.Hour).UnixMilli())
	http.SetCookie(w, &http.Cookie{Name: "fp_session", Value: token, Path: "/", MaxAge: 43200, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: strings.HasPrefix(a.Options.PublicURL, "https:") || r.TLS != nil})
}
func readBody(w http.ResponseWriter, r *http.Request) M {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	if err != nil {
		panic(Problem{413, "Request is too large", ""})
	}
	if len(data) == 0 {
		return M{}
	}
	var result M
	if caught := attempt(func() {
		var ok bool
		result, ok = decode(data).(map[string]any)
		check(ok && result != nil, "Invalid JSON object")
	}); caught != nil {
		fail("Invalid JSON object")
	}
	return result
}
func send(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(encode(v))
}
func sendFile(w http.ResponseWriter, name, kind, text string) {
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	_, _ = io.WriteString(w, text)
}
func (a *App) idle(fn func() any) any { return a.Engine.exclusive(func(string) any { return fn() }) }
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	defer func() {
		if caught := recover(); caught != nil {
			status := 500
			code := ""
			message := "Internal server error; inspect the server log"
			switch err := caught.(type) {
			case Problem:
				status = err.Status
				message = err.Message
				code = err.Code
			case *APIError:
				status = 502
				message = err.Message
				code = "NICEHASH_API_ERROR"
			default:
				fmt.Fprintln(os.Stderr, "Request failed:", panicError(caught).Error())
			}
			send(w, status, M{"error": message, "code": code})
		}
	}()
	if r.URL.Path == "/healthz" {
		send(w, 200, M{"ok": true, "version": Version, "runtime": "go"})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		a.api(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		send(w, 405, M{"error": "Method not allowed"})
		return
	}
	if r.URL.Path == "/config.js" {
		w.Header().Set("Content-Type", "text/javascript")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, "window.FP_DEMO = false;")
		return
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
	w.Header().Set("Cache-Control", "no-cache")
	http.FileServer(http.FS(a.Options.Assets)).ServeHTTP(w, r)
}
func (a *App) api(w http.ResponseWriter, r *http.Request) {
	path, method := r.URL.Path, r.Method
	if method != "GET" {
		expected := a.Options.PublicURL
		if expected == "" {
			scheme := "http://"
			if r.TLS != nil {
				scheme = "https://"
			}
			expected = scheme + r.Host
		}
		if r.Header.Get("Origin") != strings.TrimRight(expected, "/") || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			send(w, 403, M{"error": "Same-origin request required"})
			return
		}
	}
	if path == "/api/auth/status" && method == "GET" {
		send(w, 200, M{"setup": a.Store.Get("admin") == nil, "authenticated": a.authorized(r), "version": Version})
		return
	}
	if path == "/api/auth/setup" && method == "POST" {
		a.authMu.Lock()
		defer a.authMu.Unlock()
		input := readBody(w, r)
		if a.Store.Get("admin") != nil {
			conflict("Account is already configured")
		}
		check(s(input["token"]) != "" && subtle.ConstantTimeCompare([]byte(s(input["token"])), []byte(a.setupToken)) == 1, "Incorrect setup token; find it in the server console")
		check(len(s(input["password"])) >= 12 && len(s(input["password"])) <= 4096, "Use a password with 12–4096 characters")
		a.Store.Set("admin", passwordHash(s(input["password"])))
		a.setupToken = ""
		a.session(w, r)
		send(w, 200, M{"ok": true})
		return
	}
	if path == "/api/auth/login" && method == "POST" {
		a.authMu.Lock()
		defer a.authMu.Unlock()
		input := readBody(w, r)
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		at := a.attempts[ip]
		if time.Now().After(at.until) {
			at = loginAttempt{until: time.Now().Add(15 * time.Minute)}
		}
		if at.count >= 10 {
			panic(Problem{429, "Too many login attempts. Try again in 15 minutes.", ""})
		}
		if !a.checkPassword(input["password"]) {
			at.count++
			a.attempts[ip] = at
			panic(Problem{401, "Incorrect password", ""})
		}
		delete(a.attempts, ip)
		a.session(w, r)
		send(w, 200, M{"ok": true})
		return
	}
	if !a.authorized(r) {
		panic(Problem{401, "Sign in to continue", "AUTH_REQUIRED"})
	}
	if path == "/api/state" && method == "GET" {
		send(w, 200, a.State())
		return
	}
	if path == "/api/auth/logout" && method == "POST" {
		cookie, _ := r.Cookie("fp_session")
		if cookie != nil {
			a.Store.Exec("DELETE FROM sessions WHERE token=?", cookieHash(cookie.Value))
		}
		http.SetCookie(w, &http.Cookie{Name: "fp_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		send(w, 200, M{"ok": true})
		return
	}
	if path == "/api/pause" && method == "POST" {
		a.Engine.Pause("Paused by administrator")
		send(w, 200, M{"ok": true})
		return
	}
	if path == "/api/audit" && method == "POST" {
		send(w, 200, a.Engine.Audit(r.Context(), a.Connection()))
		return
	}
	if path == "/api/debug" && method == "GET" {
		send(w, 200, purchaseDebugReport(a.Store))
		return
	}
	if path == "/api/telegram" && method == "GET" {
		send(w, 200, a.Telegram.Status())
		return
	}
	if path == "/api/telegram" && method == "POST" {
		send(w, 200, a.Telegram.Configure(readBody(w, r)))
		return
	}
	if path == "/api/telegram/test" && method == "POST" {
		send(w, 200, a.Telegram.Test(r.Context()))
		return
	}
	if path == "/api/telegram/report" && method == "GET" {
		send(w, 200, a.Telegram.Report(time.Now()))
		return
	}
	if path == "/api/telegram/report" && method == "POST" {
		send(w, 200, a.Telegram.QueueReport(time.Now()))
		return
	}
	if path == "/api/debug" && method == "POST" {
		input := readBody(w, r)
		send(w, 200, a.idle(func() any { return configurePurchaseDebug(a.Store, input) }))
		return
	}
	if path == "/api/debug/traces" && method == "DELETE" {
		send(w, 200, a.idle(func() any { a.Store.Exec("DELETE FROM purchase_debug"); return debugStatus(a.Store) }))
		return
	}
	if path == "/api/sync" && method == "POST" {
		send(w, 200, a.Engine.SyncNow(r.Context()))
		return
	}
	if path == "/api/tick" && method == "POST" {
		send(w, 200, a.Engine.Tick(r.Context(), true))
		return
	}
	if path == "/api/purchases/quote" && method == "POST" {
		send(w, 200, a.Engine.Quote(r.Context(), readBody(w, r)))
		return
	}
	if path == "/api/purchases" && method == "POST" {
		send(w, 200, a.Engine.ManualBuy(r.Context(), readBody(w, r)))
		return
	}
	if path == "/api/payout-addresses" && method == "GET" {
		send(w, 200, a.idle(func() any {
			return M{"addresses": a.Engine.Client().Addresses(r.Context(), r.URL.Query().Get("currency"))}
		}))
		return
	}
	if path == "/api/rates" && method == "POST" {
		send(w, 200, a.idle(func() any {
			return M{"rates": a.Engine.RefreshRates(r.Context(), true), "error": obj(a.Store.Get("runtime"))["ratesError"]}
		}))
		return
	}
	if path == "/api/export" && method == "GET" {
		a.export(w, r)
		return
	}
	if method == "POST" || method == "DELETE" {
		input := readBody(w, r)
		result := a.idle(func() any {
			switch {
			case path == "/api/settings" && method == "POST":
				old := obj(a.Store.Get("settings"))
				settings := validateSettings(input, old)
				profileChanged := purchaseProfile(settings) != purchaseProfile(old)
				if profileChanged || s(settings["mode"]) != s(old["mode"]) {
					settings["running"] = false
					settings["liveArmed"] = false
				}
				check(!(s(settings["mode"]) == "live" && b(settings["running"])) || (b(settings["liveArmed"]) && b(a.Store.Get("verified"))), "Verify the connection and arm live buying first")
				a.Store.Set("settings", settings)
				if profileChanged {
					a.Engine.api = nil
					a.Store.Set("packages", []M{})
					a.Store.Event("warning", "Purchase API format changed to "+purchaseProfile(settings)+"; engine paused and live buying disarmed")
				}
				a.Store.Event("info", "Settings updated")
				return M{"ok": true}
			case path == "/api/arm" && method == "POST":
				check(s(input["confirm"]) == "ENABLE LIVE BUYING" && a.checkPassword(input["password"]), "Enter your administrator password and type ENABLE LIVE BUYING")
				check(b(a.Store.Get("verified")), "Test and sync the API connection first")
				a.Engine.Pause("Preparing live buying")
				a.Engine.sync(r.Context())
				a.Engine.RefreshPackages(r.Context())
				runtime := obj(a.Store.Get("runtime"))
				check(buyingHistoryReady(runtime), armingHistoryError(runtime))
				for _, o := range a.Store.List("orders") {
					// Match sync, buying guards and diagnostics: retired audit aliases
					// retain their old markers but are not current financial positions.
					if !current(o) || s(o["mode"]) != "live" {
						continue
					}
					check(!contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])), "Reconcile unresolved orders first")
					check(!held(o) && !orderSyncBlocksBuying(o), "A purchase still needs spending verification; review its sync details")
				}
				settings := obj(a.Store.Get("settings"))
				settings["mode"] = "live"
				settings["liveArmed"] = true
				settings["running"] = false
				a.Store.Set("settings", settings)
				a.Store.Event("warning", "Live buying armed by administrator")
				return M{"ok": true}
			case path == "/api/strategies" && method == "POST":
				old := findBy(a.Store.List("strategies"), "id", input["id"])
				st := validateStrategy(input, old)
				if old != nil && paymentMarket(st) != paymentMarket(old) {
					for _, o := range a.Store.List("orders") {
						check(s(o["strategyId"]) != s(old["id"]) || !funded(o), "Create a separate strategy to change the payment market after a purchase")
					}
				}
				st["id"] = first(old["id"], uuid())
				st["createdAt"] = first(old["createdAt"], stamp())
				a.Store.Save("strategies", st)
				a.Store.Event("info", "Strategy saved: "+s(st["name"]))
				return M{"ok": true, "id": st["id"]}
			case strings.HasPrefix(path, "/api/strategies/") && method == "DELETE":
				a.Store.Exec("DELETE FROM strategies WHERE id=?", strings.TrimPrefix(path, "/api/strategies/"))
				return M{"ok": true}
			case path == "/api/connection" && method == "POST":
				raw := input
				if input["nicehash"] != nil {
					raw = obj(input["nicehash"])
				}
				old := a.Credentials()
				c := normalizeCredentials(M{"orgId": strfirst(raw["organization_id"], raw["orgId"], old["orgId"]), "key": strfirst(raw["api_key"], raw["key"], old["key"]), "secret": strfirst(raw["api_secret"], raw["secret"], old["secret"]), "baseUrl": strfirst(raw["base_url"], raw["baseUrl"], old["baseUrl"], BaseURL)})
				a.checkLedgerOrg(c)
				a.Store.Set("credentials", a.Store.Seal(c))
				a.Store.Set("credentialSource", "web")
				a.Store.Set("organizationId", c["orgId"])
				a.Store.Set("verified", false)
				a.Engine.api = nil
				a.Engine.Pause("Connection updated")
				return M{"ok": true}
			case path == "/api/connection/server" && method == "POST":
				check(a.Options.ServerCredentials != nil, strfirst(a.Options.ConfigError, "No complete NiceHash server configuration is available"))
				a.checkLedgerOrg(a.Options.ServerCredentials)
				a.Store.Set("credentialSource", "server")
				a.Store.Set("organizationId", a.Options.ServerCredentials["orgId"])
				a.Store.Set("verified", false)
				a.Engine.api = nil
				a.Engine.Pause("Using server NiceHash configuration")
				return M{"ok": true}
			case path == "/api/connection" && method == "DELETE":
				a.Engine.Pause("Connection disconnected")
				a.Store.Exec("DELETE FROM kv WHERE key IN ('credentials','organizationId','verified')")
				a.Store.Set("credentialSource", "none")
				a.Engine.api = nil
				return M{"ok": true}
			case path == "/api/import" && method == "POST":
				return a.Engine.Import(obj(input["backup"]), obj(input["options"]))
			case path == "/api/import-strategies" && method == "POST":
				rows, ok := input["strategies"].([]any)
				check(ok && len(rows) <= 100, "Expected up to 100 strategies")
				clean := []M{}
				for _, row := range rows {
					st := validateStrategy(merge(obj(row), M{"enabled": false}), nil)
					st["id"] = uuid()
					st["lastBuyAt"] = nil
					clean = append(clean, st)
				}
				a.Store.Batch(func(tx *Store) {
					for _, st := range clean {
						tx.Save("strategies", st)
					}
				})
				return M{"ok": true}
			case path == "/api/password" && method == "POST":
				check(a.checkPassword(input["current"]) && len(s(input["password"])) >= 12 && len(s(input["password"])) <= 4096, "Enter current password and a new password with 12–4096 characters")
				a.Store.Set("admin", passwordHash(s(input["password"])))
				a.Store.Exec("DELETE FROM sessions")
				a.session(w, r)
				return M{"ok": true}
			case path == "/api/reward-confirmation" && method == "POST":
				reward := findBy(a.Store.List("rewards"), "id", input["id"])
				check(reward != nil && rewardAccounted(reward) && !b(reward["confirmed"]), "Reward is already confirmed or does not exist")
				check(a.checkPassword(input["password"]) && len(strings.TrimSpace(s(input["note"]))) >= 10, "Provide your password and verified payout transaction/source")
				reward["confirmed"] = true
				reward["confirmedAt"] = stamp()
				reward["manualConfirmed"] = M{"at": reward["confirmedAt"], "note": input["note"]}
				usdtRewardValue(reward, obj(obj(a.Store.Get("runtime"))["rates"]))
				a.Store.Save("rewards", reward)
				a.Store.Event("warning", "Payout manually confirmed: "+s(reward["id"]))
				return M{"ok": true}
			case path == "/api/reward-value" && method == "POST":
				reward := findBy(a.Store.List("rewards"), "id", input["id"])
				currency := strfirst(input["currency"], "BTC")
				check(supportedMarket(currency), "Invalid valuation currency")
				check(reward != nil && !integer(rewardMarketValue(reward, currency)), "Reward does not need valuation")
				value := input["valueBtc"]
				if currency == "USDT" {
					value = input["valueUsdt"]
				}
				check(integer(value) && n(value) >= 0 && len(s(input["note"])) >= 10, "Provide "+currency+" value and a source note")
				if currency == "USDT" {
					reward["valueUsdt"] = value
					reward["manualUsdtValuation"] = M{"at": stamp(), "note": input["note"]}
					reward["usdtValuation"] = "Manual USDT valuation: " + s(input["note"])
					a.Store.Save("rewards", reward)
					return M{"ok": true}
				}
				reward["valueBtc"] = input["valueBtc"]
				reward["valuation"] = "Manual valuation: " + s(input["note"])
				a.Store.Save("rewards", reward)
				return M{"ok": true}
			case path == "/api/reconcile" && method == "POST":
				return a.reconcile(r, input)
			}
			panic(Problem{404, "Unknown endpoint", ""})
		})
		send(w, 200, result)
		return
	}
	send(w, 404, M{"error": "Unknown endpoint"})
}
func (a *App) checkLedgerOrg(c M) {
	old := s(a.Store.Get("ledgerOrgId"))
	if old != "" && !strings.EqualFold(old, s(c["orgId"])) {
		for _, o := range a.Store.List("orders") {
			check(s(o["mode"]) != "live", "This ledger belongs to another organization. Use a separate instance.")
		}
	}
}
func (a *App) reconcile(r *http.Request, input M) any {
	o := findBy(a.Store.List("orders"), "id", input["id"])
	check(o != nil && contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])), "Order does not need reconciliation")
	a.Engine.Pause("Purchase reconciliation")
	note := strings.TrimSpace(s(input["note"]))
	if o["pendingTeamPurchase"] != nil && s(input["confirm"]) == "VERIFIED NO ADDITION" {
		check(a.checkPassword(input["password"]) && len(note) >= 10, "Provide your password and evidence that the last addition was not charged")
		resolveUnbought(o, note)
		a.Store.Save("orders", o)
		return M{"ok": true}
	}
	if o["pendingTeamPurchase"] != nil && s(input["confirm"]) == "VERIFIED NO PURCHASE" {
		fail("This team contains earlier purchases. Verify only the last addition with VERIFIED NO ADDITION.")
	}
	if s(input["externalId"]) != "" {
		raw := a.Engine.Client().Ticket(r.Context(), s(input["externalId"]), s(o["kind"]) == "team")
		var imported M
		if s(o["kind"]) == "team" {
			check(s(raw["id"]) == s(o["packageId"]), "This is a different team package")
			imported = a.Engine.importTeam(raw, obj(obj(a.Store.Get("runtime"))["rates"]), nil)
		} else {
			imported = a.Engine.importSolo(r.Context(), raw, obj(obj(a.Store.Get("runtime"))["rates"]))
		}
		check(imported != nil, "Response still does not identify this organization. Keep the reservation until membership or debit is verified.")
		if s(imported["id"]) != s(o["id"]) {
			a.Store.Batch(func(tx *Store) {
				for _, reward := range tx.List("rewards") {
					if s(reward["orderId"]) == s(imported["id"]) {
						reward["orderId"] = o["id"]
						tx.Save("rewards", reward)
					}
				}
				tx.Exec("DELETE FROM orders WHERE id=?", imported["id"])
				tx.Save("orders", merge(o, imported, pick(o, []string{"id", "strategyId", "requestId", "createdAt"})))
			})
		}
	} else if s(input["action"]) == "final-debit" {
		check(a.checkPassword(input["password"]) && len(note) >= 10, "Provide password and a source note for the verified final debit/refund")
		market := paymentMarket(o)
		cost, refund := input["costBtc"], input["refundBtc"]
		if market == "USDT" {
			cost, refund = input["costAmount"], input["refundAmount"]
		}
		check(integer(cost) && integer(refund) && n(cost) >= 0 && n(refund) >= 0 && n(refund) <= n(cost), "Provide valid cost and refund amounts")
		p := obj(o["pendingTeamPurchase"])
		check(n(cost) >= money(obj(p["before"]), "costBtc"), "Total cost cannot discard earlier verified team purchases")
		old := netCost(o)
		history := spendEntries(o)
		values := fundingRecord(market, M{"costBtc": n(cost), "refundBtc": n(refund), "feeBtc": 0, "status": "COMPLETED"})
		o["accountingOverride"] = M{"at": stamp(), "note": note, "values": values}
		o = merge(o, values)
		o["accountingNote"] = "Manually reconciled: " + note
		if len(p) > 0 {
			buys := maps(o["teamBuys"])
			for _, entry := range buys {
				if s(entry["requestId"]) == s(p["requestId"]) {
					entry["status"] = "MANUALLY_VERIFIED"
					entry["resolution"] = note
				}
			}
			o["teamBuys"] = buys
			delete(o, "pendingTeamPurchase")
			delete(o, "syncPending")
			delete(o, "error")
			o["spendHistory"] = append(history, spendEntry(market, stamp(), netCost(o)-old, "Manually verified final team commitment/refund"))
		}
		a.Store.Save("orders", o)
	} else {
		check(s(input["confirm"]) == "VERIFIED NO PURCHASE" && a.checkPassword(input["password"]) && len(note) >= 10, "Verify no purchase was charged, then provide password, confirmation phrase and source note")
		o["status"] = "FAILED"
		setMoney(o, "feeBtc", 0)
		o["resolution"] = note
		if s(o["kind"]) == "team" {
			o["attemptedTeamId"] = o["externalId"]
			o["externalId"] = nil
		}
		a.Store.Save("orders", o)
	}
	a.Store.Event("warning", "Purchase reconciled by administrator: "+s(o["id"]))
	return M{"ok": true}
}
func (a *App) export(w http.ResponseWriter, r *http.Request) {
	state := a.Store.State()
	format := r.URL.Query().Get("format")
	if format == "settings" {
		sendFile(w, "easymining-settings.json", "application/json", string(encode(configurationBackup(state))))
		return
	}
	if format == "purchase-diagnostics" {
		sendFile(w, "easymining-purchase-diagnostics.json", "application/json", string(encode(diagnostics(state, a.Connection()))))
		return
	}
	mode := strfirst(r.URL.Query().Get("mode"), obj(state["settings"])["mode"])
	check(mode == "paper" || mode == "live", "Invalid reporting mode")
	market := strfirst(r.URL.Query().Get("market"), "BTC")
	check(supportedMarket(market), "Invalid reporting market")
	if format == "csv" {
		sendFile(w, "easymining-ledger.csv", "text/csv; charset=utf-8", ledgerCSV(state, mode, market))
		return
	}
	if format == "daily-csv" {
		days := 30
		if text := r.URL.Query().Get("days"); text != "" {
			i, err := strconv.Atoi(text)
			check(err == nil, "Invalid reporting days")
			days = i
		}
		rates := obj(obj(state["runtime"])["exchangeRates"])
		report := dailyReport(maps(state["orders"]), maps(state["rewards"]), mode, s(obj(state["settings"])["timezone"]), days, time.Now(), rates, market)
		sendFile(w, "easymining-daily-"+mode+".csv", "text/csv; charset=utf-8", dailyCSV(report, rates))
		return
	}
	settings := obj(state["settings"])
	settings["running"] = false
	settings["liveArmed"] = false
	state["version"] = Version
	state["exportedAt"] = stamp()
	sendFile(w, "easymining-backup.json", "application/json", string(encode(state)))
}
func LoadServerConfig() (credentials M, source, configError string) {
	caught := attempt(func() {
		file := os.Getenv("NICEHASH_CONFIG_FILE")
		_, exists := os.Stat("config.json")
		if file != "" || exists == nil {
			if file == "" {
				file = "config.json"
			}
			data, err := os.ReadFile(filepath.Clean(file))
			must(err)
			raw := obj(decode(data))
			check(raw["nicehash"] != nil, "Configuration JSON must contain a nicehash object")
			credentials = normalizeCredentials(obj(raw["nicehash"]))
			source = "config.json"
			return
		}
		raw := M{"api_key": os.Getenv("NICEHASH_API_KEY"), "api_secret": os.Getenv("NICEHASH_API_SECRET"), "organization_id": strfirst(os.Getenv("NICEHASH_ORGANIZATION_ID"), os.Getenv("NICEHASH_ORG_ID")), "base_url": strfirst(os.Getenv("NICEHASH_BASE_URL"), BaseURL)}
		if s(raw["api_key"])+s(raw["api_secret"])+s(raw["organization_id"]) == "" {
			return
		}
		credentials = normalizeCredentials(raw)
		source = "environment"
	})
	if caught != nil {
		credentials = nil
		source = ""
		configError = panicError(caught).Error()
	}
	return
}
