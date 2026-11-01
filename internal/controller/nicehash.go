package controller

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

const BaseURL = "https://api2.nicehash.com"

type APIError struct {
	HTTPStatus                                        int
	Code                                              any
	Method, Path, RequestID, Message, ProviderMessage string
	Uncertain                                         bool
	Offset                                            int64
	Trace                                             M
	ProviderErrorID                                   string
}

func (e *APIError) Error() string { return e.Message }
func (e *APIError) Rejected() bool {
	return e.Method == "POST" && !e.Uncertain && contains([]string{"400", "401", "403", "404", "405", "410", "422", "429"}, fmt.Sprint(e.HTTPStatus))
}
func teamPurchaseTarget(path string) string {
	for _, profile := range []string{"documented", "web"} {
		prefix := teamPurchasePath(profile, "")
		if strings.HasPrefix(path, prefix) && uuidRE.MatchString(strings.TrimPrefix(path, prefix)) {
			return strings.TrimPrefix(path, prefix)
		}
	}
	return ""
}
func (e *APIError) TeamStateRejected() bool {
	// Only the exact, definitive team POST rejection is safe to skip.
	// A timeout, GET, unrelated endpoint or 5xx with the same code still fails closed.
	return e.Rejected() && e.HTTPStatus == 400 && s(e.Code) == "5251" && teamPurchaseTarget(e.Path) != ""
}
func teamStateRejectedFailure(f M) bool {
	err := &APIError{HTTPStatus: int(n(f["httpStatus"])), Code: f["code"], Method: s(f["method"]), Path: s(f["path"]), Uncertain: b(f["uncertain"])}
	return b(f["rejected"]) && err.TeamStateRejected()
}
func (e *APIError) Details() M {
	return M{"provider": "NiceHash", "httpStatus": e.HTTPStatus, "code": e.Code, "message": e.ProviderMessage, "method": e.Method, "path": e.Path, "requestId": e.RequestID, "clockOffsetMs": e.Offset, "request": e.Trace, "providerErrorId": e.ProviderErrorID}
}
func Sign(c M, method, path, query, at, nonce string, body []byte) string {
	message := strings.Join([]string{s(c["key"]), at, nonce, "", s(c["orgId"]), "", method, path, query}, "\x00")
	if len(body) > 0 {
		message += "\x00" + string(body)
	}
	mac := hmac.New(sha256.New, []byte(s(c["secret"])))
	mac.Write([]byte(message))
	return s(c["key"]) + ":" + hex.EncodeToString(mac.Sum(nil))
}

type NiceHash struct {
	Credentials          M
	HTTP                 *http.Client
	Offset               int64
	PurchaseProfile      string
	HistoryReadPrefixes  map[string]string
	HistoryReadFallbacks []M
}

func NewNiceHash(c M) *NiceHash {
	return &NiceHash{Credentials: c, HTTP: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func sanitize(text string, c M, extras ...string) string {
	for _, key := range []string{"key", "secret", "orgId"} {
		if value := s(c[key]); value != "" {
			text = strings.ReplaceAll(text, value, "[redacted]")
		}
	}
	for _, value := range extras {
		if value != "" {
			text = strings.ReplaceAll(text, value, "[redacted]")
		}
	}
	text = regexp.MustCompile(`[\x00-\x1f\x7f]`).ReplaceAllString(text, " ")
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}
func (api *NiceHash) Request(ctx context.Context, method, path string, query url.Values, payload any, private bool, requestID, twofa string) any {
	check(strings.HasPrefix(path, "/"), "Invalid API path")
	if requestID == "" {
		requestID = uuid()
	}
	var body []byte
	if payload != nil {
		body = encode(payload)
	}
	q := query.Encode()
	base := strfirst(api.Credentials["baseUrl"], BaseURL)
	endpoint := base + path
	if q != "" {
		endpoint += "?" + q
	}
	req, e := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	must(e)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "FastPool-EasyMining/"+Version+" (Go)")
	if private {
		check(s(api.Credentials["key"]) != "", "Connect a NiceHash API key first")
		at := fmt.Sprint(time.Now().UnixMilli() + api.Offset)
		nonce := uuid()
		req.Header.Set("X-Time", at)
		req.Header.Set("X-Nonce", nonce)
		req.Header.Set("X-Organization-Id", s(api.Credentials["orgId"]))
		req.Header.Set("X-Auth", Sign(api.Credentials, method, path, q, at, nonce, body))
		req.Header.Set("X-Request-Id", requestID)
		if twofa != "" {
			check(regexp.MustCompile(`^\d{6,8}$`).MatchString(twofa), "Enter a current NiceHash 2FA code")
			req.Header.Set("X-Twofa-Token", twofa)
		}
	}
	failure := &APIError{Method: method, Path: path, RequestID: requestID, Offset: api.Offset, Uncertain: method == "POST"}
	if method == "POST" {
		digest := sha256.Sum256(body)
		raw := obj(decode(body))
		failure.Trace = M{"amount": raw["amount"], "shares": raw["shares"], "clear": raw["clear"], "ticketId": raw["ticketId"], "buyWithCurrency": raw["buyWithCurrency"], "payloadBytes": len(body), "payloadSHA256": hex.EncodeToString(digest[:])}
		keys := []string{}
		for k := range raw {
			if strings.Contains(k, "Addr") {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		failure.Trace["payoutFieldNames"] = keys
	}
	debugResponse := beginDebugRequest(ctx, req, path, query, body, api.Offset)
	response, e := api.HTTP.Do(req)
	if e != nil {
		debugResponse(response, nil, e)
		failure.Message = "NiceHash response was not received; verify submitted purchases before reconciliation"
		panic(failure)
	}
	defer response.Body.Close()
	failure.HTTPStatus = response.StatusCode
	data, e := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024+1))
	if e != nil || len(data) > 16*1024*1024 {
		debugResponse(response, nil, fmt.Errorf("Response interrupted or exceeded size limit"))
		failure.Message = "NiceHash response was interrupted or exceeded the size limit"
		panic(failure)
	}
	var parsed any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	e = decoder.Decode(&parsed)
	if e == nil {
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			e = fmt.Errorf("Trailing JSON data")
		}
	}
	if e != nil {
		debugResponse(response, nil, fmt.Errorf("Response was not valid JSON"))
		failure.Message = fmt.Sprintf("NiceHash returned a non-JSON response (HTTP %d)", response.StatusCode)
		panic(failure)
	}
	debugResponse(response, parsed, nil)
	root := obj(parsed)
	errors := maps(root["errors"])
	provider := obj(root["error"])
	if len(errors) > 0 {
		provider = errors[0]
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || root["error"] != nil || len(errors) > 0 {
		failure.Code = first(provider["code"], "unknown")
		if uuidRE.MatchString(s(root["error_id"])) {
			failure.ProviderErrorID = s(root["error_id"])
		}
		failure.ProviderMessage = sanitize(strfirst(provider["message"], root["error"]), api.Credentials, twofa)
		failure.Uncertain = method == "POST" && !(contains([]string{"400", "401", "403", "404", "405", "410", "422", "429"}, fmt.Sprint(response.StatusCode)))
		failure.Message = fmt.Sprintf("NiceHash rejected %s %s (HTTP %d, code %v). %s", method, path, response.StatusCode, failure.Code, failure.ProviderMessage)
		panic(failure)
	}
	return parsed
}
func (api *NiceHash) Get(ctx context.Context, path string, query url.Values, private bool) any {
	return api.Request(ctx, "GET", path, query, nil, private, "", "")
}
func (api *NiceHash) Clock(ctx context.Context) {
	begin := time.Now().UnixMilli()
	d := obj(api.Get(ctx, "/api/v2/time", nil, false))
	check(integer(d["serverTime"]) && n(d["serverTime"]) > 0, "Unexpected server time response")
	api.Offset = n(d["serverTime"]) - (begin+time.Now().UnixMilli())/2
}
func (api *NiceHash) Pages(ctx context.Context, path string, query url.Values, private bool) []M {
	if query == nil {
		query = url.Values{}
	}
	out := []M{}
	for page := 0; page < 50; page++ {
		query.Set("page", fmt.Sprint(page))
		query.Set("limit", "100")
		var response any
		if private {
			response = api.historyGet(ctx, path, query)
		} else {
			response = api.Get(ctx, path, query, false)
		}
		d := obj(response)
		_, ok := d["list"].([]any)
		check(ok, "Unexpected ticket list schema")
		list := maps(d["list"])
		out = append(out, list...)
		if len(list) < 100 {
			return out
		}
	}
	fail("History exceeded 5,000 tickets; account sync is incomplete")
	return nil
}
func (api *NiceHash) Packages(ctx context.Context) []M {
	raw := api.Get(ctx, "/main/api/v2/public/solo/package", nil, false)
	_, ok := raw.([]any)
	check(ok, "Unexpected package catalogue response")
	out := []M{}
	at := stamp()
	for _, p := range maps(raw) {
		out = append(out, normalizePackage(p, at, false))
	}
	for _, p := range api.Pages(ctx, "/main/api/v2/public/solo/shared/order", url.Values{"onlyGold": {"false"}}, false) {
		out = append(out, normalizePackage(p, at, true))
	}
	return out
}
func (api *NiceHash) Ticket(ctx context.Context, id string, team bool) M {
	check(uuidRE.MatchString(id), "Invalid NiceHash ticket ID")
	return obj(api.historyGet(ctx, api.TicketListPath(team)+"/"+id, nil))
}
func normalizePackage(raw M, at string, team bool) M {
	p := raw
	if raw["currencyAlgoTicket"] != nil {
		p = obj(raw["currencyAlgoTicket"])
	}
	market := strfirst(p["currencyMarket"], "BTC")
	min := units(first(raw["minShareAmount"], p["minShareAmount"], p["price"]), "catalogue minimum share")
	price := min
	if !team {
		price = units(p["price"], "catalogue price")
	}
	var shares, committed, cost any
	if supportedMarket(market) {
		cost = price
	}
	if raw["totalShares"] != nil {
		check(integer(raw["totalShares"]), "Invalid catalogue share count")
		shares = n(raw["totalShares"])
	}
	if raw["addedAmount"] != nil {
		committed = units(raw["addedAmount"], "catalogue contribution")
		if shares == nil && min > 0 {
			shares = n(committed) / min
		}
	}
	available := b(p["available"])
	if team {
		available = contains([]string{"WAITING", "COUNTDOWN"}, status(raw["status"])) && status(raw["state"]) != "SOLD_OUT"
	}
	duration := n(p["duration"])
	if team && n(raw["duration"]) > 0 {
		duration = n(raw["duration"])
	}
	if duration <= 0 {
		duration = 3600
	}
	out := M{"id": raw["id"], "name": strfirst(p["name"], "Unnamed package"), "coin": strfirst(obj(p["currencyAlgo"])["currency"], "?"), "mergeCoin": obj(p["mergeCurrencyAlgo"])["currency"], "withdrawRewards": b(p["withdrawRewards"]), "market": market, "price": price, "costBtc": cost, "available": available && supportedMarket(market), "duration": duration, "odds": first(raw["probabilityPrecision"], p["probabilityPrecision"], p["probability"]), "team": team, "teamState": status(raw["state"]), "buyUntil": raw["lifeTimeTill"], "teamShares": shares, "minShare": min, "status": status(raw["status"]), "teamCommitted": committed, "blockRewards": blockRewards(p), "reward": first(obj(p["currencyAlgo"])["blockRewardWithNhFee"], obj(p["currencyAlgo"])["blockReward"]), "quotedAt": at}
	if supportedMarket(market) {
		return fundingRecord(market, out)
	}
	return out
}
func (api *NiceHash) Addresses(ctx context.Context, currency string) []M {
	check(currency == "" || coinRE.MatchString(currency), "Invalid payout currency")
	query := url.Values{}
	if currency != "" {
		query.Set("currency", currency)
	}
	raw := api.Get(ctx, purchasePrefix(api.PurchaseProfile)+"/api/v2/hashpower/sharedTicketExternalAddress/list", query, true)
	_, ok := raw.([]any)
	check(ok, "Unexpected saved payout address response")
	out := []M{}
	for _, a := range maps(raw) {
		if s(a["address"]) != "" && s(a["currency"]) != "" && (s(a["organizationId"]) == "" || strings.EqualFold(s(a["organizationId"]), s(api.Credentials["orgId"]))) {
			out = append(out, M{"id": a["id"], "currency": a["currency"], "address": a["address"], "name": strfirst(a["nickName"], "")})
		}
	}
	return out
}
func (api *NiceHash) Destination(ctx context.Context, q, input M) M {
	payout := payoutFields(input)
	check(s(payout["mergePayoutAddress"]) == "" || s(q["mergeCoin"]) != "", "This package has no merged reward coin")
	check(!b(q["withdrawRewards"]) || (s(payout["payoutAddress"]) != "" && (s(q["mergeCoin"]) == "" || s(payout["mergePayoutAddress"]) != "")), "Choose a payout address for each reward coin")
	fields := M{}
	requires := false
	if s(payout["payoutAddress"]) != "" || s(payout["mergePayoutAddress"]) != "" {
		saved := api.Addresses(ctx, "")
		for _, row := range []struct{ k, coin, prefix string }{{"payoutAddress", s(q["coin"]), "soloMiningReward"}, {"mergePayoutAddress", s(q["mergeCoin"]), "mergeSoloMiningReward"}} {
			addr := s(payout[row.k])
			if addr == "" {
				continue
			}
			var matched M
			for _, a := range saved {
				if s(a["currency"]) == row.coin && s(a["address"]) == addr {
					matched = a
					break
				}
			}
			if matched != nil {
				check(uuidRE.MatchString(s(matched["id"])), "Saved NiceHash address has an invalid ID")
				fields[row.prefix+"WithdrawalAddrId"] = matched["id"]
				debugStep(ctx, "payout_resolved", M{"coin": row.coin, "field": row.prefix + "WithdrawalAddrId", "source": "saved EasyMining address", "idFingerprint": debugFingerprint(matched["id"]), "currencyMatched": true})
			} else {
				fields[row.prefix+"Addr"] = addr
				requires = true
				debugStep(ctx, "payout_resolved", M{"coin": row.coin, "field": row.prefix + "Addr", "source": "unsaved address", "requiresTwofa": true})
			}
		}
	}
	if len(fields) == 0 {
		debugStep(ctx, "payout_resolved", M{"source": "default / claim", "requiresTwofa": false})
	}
	return M{"fields": fields, "requiresTwofa": requires}
}

// Struct order intentionally preserves the user-confirmed v1.2.4 payload bytes.
type teamBuyBody struct {
	Amount    json.Number `json:"amount,omitempty"`
	Shares    smallShares `json:"shares"`
	Clear     *bool       `json:"clear,omitempty"`
	SoloAddr  string      `json:"soloMiningRewardAddr,omitempty"`
	MergeAddr string      `json:"mergeSoloMiningRewardAddr,omitempty"`
	SoloID    string      `json:"soloMiningRewardWithdrawalAddrId,omitempty"`
	MergeID   string      `json:"mergeSoloMiningRewardWithdrawalAddrId,omitempty"`
}
type smallShares struct {
	Small int64 `json:"small"`
}

func makeTeamBuyBody(q, st, fields, update M) teamBuyBody {
	cost, shares := money(q, "costBtc"), n(st["shares"])
	if update != nil {
		check(money(update, "targetCostBtc") == money(update, "beforeCostBtc")+cost && n(update["targetShares"]) == n(update["beforeShares"])+shares, "Invalid cumulative team purchase")
		cost = money(update, "targetCostBtc")
		shares = n(update["targetShares"])
	}
	clear := false
	return teamBuyBody{amountJSON(cost), smallShares{shares}, &clear, s(fields["soloMiningRewardAddr"]), s(fields["mergeSoloMiningRewardAddr"]), s(fields["soloMiningRewardWithdrawalAddrId"]), s(fields["mergeSoloMiningRewardWithdrawalAddrId"])}
}
func (api *NiceHash) Buy(ctx context.Context, q, st M, requestID, twofa string, destination, update M) M {
	market := paymentMarket(q)
	check(supportedMarket(market), "Unsupported package payment market")
	if destination == nil {
		destination = api.Destination(ctx, q, st)
	}
	check(!b(destination["requiresTwofa"]) || regexp.MustCompile(`^\d{6,8}$`).MatchString(twofa), "An unsaved payout address requires a current NiceHash 2FA code")
	fields := obj(destination["fields"])
	if s(st["mode"]) == "team" {
		body := api.TeamBody(q, st, fields, update)
		d := obj(api.Request(ctx, "POST", api.TeamBuyPath(s(q["id"])), nil, body, true, requestID, twofa))
		if !b(d["success"]) || contains([]string{"NOT_SUCCESSFUL", "PARTIAL_SUCCESS"}, s(d["successType"])) {
			panic(&APIError{Method: "POST", Path: api.TeamBuyPath(s(q["id"])), RequestID: requestID, Uncertain: true, Message: "Team purchase response requires reconciliation"})
		}
		return fundingRecord(market, M{"id": q["id"], "status": "PENDING", "costBtc": moneyValue(q, "costBtc")})
	}
	body := merge(M{"ticketId": q["id"], "buyWithCurrency": market}, fields)
	if market == "BTC" && (api.PurchaseProfile == "web" || api.PurchaseProfile == "guide") {
		delete(body, "buyWithCurrency")
	}
	d := obj(api.Request(ctx, "POST", api.SoloBuyPath(), nil, body, true, requestID, twofa))
	if explicit := s(d["currencyMarket"]); explicit != "" && explicit != market {
		panic(&APIError{Method: "POST", Path: api.SoloBuyPath(), RequestID: requestID, Uncertain: true, Message: "Purchase response returned a different payment currency; reconcile before buying"})
	}
	if s(d["id"]) == "" {
		panic(&APIError{Method: "POST", Path: api.SoloBuyPath(), RequestID: requestID, Uncertain: true, Message: "Purchase response has no order ID"})
	}
	cost := int64(0)
	caught := attempt(func() {
		cost = units(first(d["amount"], amountJSON(money(q, "costBtc"))), "purchase debit")
		check(cost > 0, "Invalid debit")
	})
	if caught != nil {
		panic(&APIError{Method: "POST", Path: api.SoloBuyPath(), RequestID: requestID, Uncertain: true, Message: "Purchase response has an invalid debit; verify the order in NiceHash"})
	}
	return fundingRecord(market, M{"id": d["id"], "status": status(d["status"]), "costBtc": cost})
}
func attempt(fn func()) (caught any) { defer func() { caught = recover() }(); fn(); return nil }
func panicError(v any) error {
	if e, ok := v.(error); ok {
		return e
	}
	return fmt.Errorf("%v", v)
}

var envRE = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func configValue(value any, label string) string {
	text := strings.Trim(strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '\u200b' || r == '\u200c' || r == '\u200d' || r == '\ufeff' {
			return -1
		}
		return r
	}, s(value))), "\"'")
	text = envRE.ReplaceAllStringFunc(text, func(m string) string {
		k := m[2 : len(m)-1]
		check(strings.HasPrefix(k, "NICEHASH_"), label+": use a NICEHASH_ environment variable")
		v := strings.TrimSpace(os.Getenv(k))
		check(v != "", k+" is not set in the server environment")
		return v
	})
	check(!strings.Contains(text, "${"), label+": unresolved environment placeholder")
	return text
}
func normalizeCredentials(input M) M {
	if input["nicehash"] != nil {
		input = obj(input["nicehash"])
	}
	base := configValue(first(input["base_url"], input["baseUrl"], BaseURL), "NiceHash base URL")
	check(contains([]string{BaseURL, "https://api-test.nicehash.com"}, strings.TrimRight(base, "/")), "Base URL must be https://api2.nicehash.com or https://api-test.nicehash.com")
	c := M{"key": configValue(first(input["api_key"], input["key"]), "API key"), "secret": configValue(first(input["api_secret"], input["secret"]), "API secret"), "orgId": strings.ToLower(configValue(first(input["organization_id"], input["orgId"]), "Organization ID")), "baseUrl": strings.TrimRight(base, "/")}
	check(s(c["key"]) != "" && s(c["secret"]) != "" && uuidRE.MatchString(s(c["orgId"])), "Provide API key, secret and the organization UUID from NiceHash API Keys settings")
	check(!strings.ContainsAny(s(c["key"])+s(c["secret"]), " \t\r\n"), "API key or secret contains whitespace")
	return c
}
