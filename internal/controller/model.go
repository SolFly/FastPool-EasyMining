package controller

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

func defaultSettings() M {
	return M{"purchaseRequestProfile": "documented", "usdtLimits": usdtLimits(), "mode": "paper", "running": false, "liveArmed": false, "dailyCap": int64(100000), "weeklyCap": int64(500000), "monthlyCap": int64(1500000), "maxOrder": int64(100000), "reserve": int64(100000), "stopLoss": int64(300000), "takeProfit": int64(1000000), "maxActive": 3, "maxErrors": 3, "pollSeconds": 60, "autoSync": true, "accountSyncSeconds": 60, "timezone": "Europe/Sofia", "paperBalance": int64(2000000), "feeBufferBps": 100, "displayCurrency": "BTC", "startHour": "00:00", "endHour": "23:59"}
}
func defaultStrategy() M {
	return M{"name": "New strategy", "market": "BTC", "continuous": true, "enabled": false, "kind": "interval", "mode": "solo", "coin": "BTC", "packageName": "Gold S", "packageId": "", "intervalMinutes": 60, "shares": 1, "maxPrice": int64(10000), "budget": int64(100000), "maxPurchases": 10, "minTeamShares": 50, "teamLevels": []any{}, "maxOdds": 50000, "stopOnWin": false, "startHour": "00:00", "endHour": "23:59", "days": []any{0, 1, 2, 3, 4, 5, 6}, "lastBuyAt": nil, "createdAt": stamp()}
}

var timeRE = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
var addressRE = regexp.MustCompile(`^[A-Za-z0-9:._-]{14,200}$`)
var uuidRE = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
var coinRE = regexp.MustCompile(`^[A-Z0-9]{2,12}$`)

func validateSettings(input, prior M) M {
	r := merge(defaultSettings(), prior)
	if has(input, "usdtLimits") {
		limits, ok := input["usdtLimits"].(map[string]any)
		check(ok, "USDT limits must be an object")
		clean := merge(usdtLimits(), obj(r["usdtLimits"]))
		for k := range usdtLimits() {
			if has(limits, k) {
				check(integer(limits[k]) && n(limits[k]) >= 0, "Invalid USDT "+k)
				clean[k] = n(limits[k])
			}
		}
		check(n(clean["maxOrder"]) <= n(clean["dailyCap"]) && n(clean["dailyCap"]) <= n(clean["weeklyCap"]) && n(clean["weeklyCap"]) <= n(clean["monthlyCap"]), "USDT caps must increase from order to daily, weekly and monthly")
		r["usdtLimits"] = clean
	}
	for _, k := range []string{"dailyCap", "weeklyCap", "monthlyCap", "maxOrder", "reserve", "stopLoss", "takeProfit", "paperBalance"} {
		if has(input, k) {
			check(integer(input[k]) && n(input[k]) >= 0, k+" must be a nonnegative amount")
			r[k] = n(input[k])
		}
	}
	for _, row := range []struct {
		k        string
		min, max int64
	}{{"maxActive", 1, 100}, {"maxErrors", 1, 100}, {"pollSeconds", 30, 3600}, {"accountSyncSeconds", 30, 3600}, {"feeBufferBps", 0, 1000}} {
		if has(input, row.k) {
			check(integer(input[row.k]) && n(input[row.k]) >= row.min && n(input[row.k]) <= row.max, "Invalid "+row.k)
			r[row.k] = n(input[row.k])
		}
	}
	if has(input, "timezone") {
		_, e := time.LoadLocation(s(input["timezone"]))
		check(e == nil, "Invalid timezone")
		r["timezone"] = input["timezone"]
	}
	for k, choices := range map[string][]string{"mode": {"paper", "live"}, "displayCurrency": {"BTC", "USD", "EUR"}, "purchaseRequestProfile": {"documented", "web", "guide"}} {
		if has(input, k) {
			check(contains(choices, s(input[k])), "Invalid "+k)
			r[k] = input[k]
		}
	}
	for _, k := range []string{"startHour", "endHour"} {
		if has(input, k) {
			check(timeRE.MatchString(s(input[k])), "Invalid time")
			r[k] = input[k]
		}
	}
	for _, k := range []string{"running", "autoSync"} {
		if has(input, k) {
			_, ok := input[k].(bool)
			check(ok, k+" must be true or false")
			r[k] = input[k]
		}
	}
	check(n(r["maxOrder"]) > 0 && n(r["dailyCap"]) > 0 && n(r["weeklyCap"]) > 0 && n(r["monthlyCap"]) > 0, "Spending caps must be positive")
	check(n(r["maxOrder"]) <= n(r["dailyCap"]), "Order cap exceeds daily cap")
	check(n(r["dailyCap"]) <= n(r["weeklyCap"]) && n(r["weeklyCap"]) <= n(r["monthlyCap"]), "Caps must increase from daily to monthly")
	return r
}
func payoutFields(input M) M {
	out := M{}
	for _, k := range []string{"payoutAddress", "mergePayoutAddress"} {
		address := strings.TrimSpace(s(input[k]))
		check(address == "" || addressRE.MatchString(address), "Enter a valid payout address without spaces (14–200 characters)")
		out[k] = address
	}
	return out
}
func validateStrategy(input, prior M) M {
	r := merge(defaultStrategy(), prior)
	for _, k := range []string{"name", "packageName", "packageId", "coin"} {
		if has(input, k) {
			x := strings.TrimSpace(s(input[k]))
			if len(x) > 120 {
				x = x[:120]
			}
			r[k] = x
		}
	}
	check(s(r["name"]) != "", "Give the strategy a name")
	for k, choices := range map[string][]string{"market": {"BTC", "USDT"}, "kind": {"interval", "price", "odds", "team"}, "mode": {"solo", "team"}} {
		if has(input, k) {
			check(contains(choices, s(input[k])), "Invalid "+k)
			r[k] = input[k]
		}
	}
	for _, row := range []struct {
		k        string
		min, max int64
	}{{"intervalMinutes", 1, 43200}, {"shares", 1, 100}, {"maxPurchases", 1, 100000}, {"minTeamShares", 0, 100000}, {"maxOdds", 1, 1000000000}} {
		if has(input, row.k) {
			check(integer(input[row.k]) && n(input[row.k]) >= row.min && n(input[row.k]) <= row.max, "Invalid "+row.k)
			r[row.k] = n(input[row.k])
		}
	}
	for _, k := range []string{"maxPrice", "budget"} {
		if has(input, k) {
			check(integer(input[k]) && n(input[k]) > 0, "Invalid "+k)
			r[k] = n(input[k])
		}
	}
	if !b(r["continuous"]) {
		check(n(r["budget"]) >= n(r["maxPrice"]), "Strategy budget must cover at least one purchase")
	}
	for _, k := range []string{"enabled", "stopOnWin", "continuous"} {
		if has(input, k) {
			_, ok := input[k].(bool)
			check(ok, "Invalid "+k)
			r[k] = input[k]
		}
	}
	for _, k := range []string{"startHour", "endHour"} {
		if has(input, k) {
			check(timeRE.MatchString(s(input[k])), "Invalid time")
			r[k] = input[k]
		}
	}
	if has(input, "days") {
		a, ok := input["days"].([]any)
		check(ok && len(a) > 0, "Select valid weekdays")
		for _, v := range a {
			check(integer(v) && n(v) >= 0 && n(v) <= 6, "Select valid weekdays")
		}
		r["days"] = a
	}
	if s(r["kind"]) == "team" {
		r["mode"] = "team"
	}
	if has(input, "teamLevels") {
		levels, ok := input["teamLevels"].([]any)
		check(ok && len(levels) <= 20, "Choose up to 20 team buying levels")
		previous := int64(-1)
		clean := []any{}
		for _, v := range levels {
			row := obj(v)
			check(integer(row["threshold"]) && n(row["threshold"]) >= 0 && n(row["threshold"]) <= 100000 && n(row["threshold"]) > previous, "Team thresholds must be increasing whole numbers from 0 to 100000")
			check(integer(row["shares"]) && n(row["shares"]) >= 1 && n(row["shares"]) <= 100, "Buy 1–100 additional shares at each level")
			previous = n(row["threshold"])
			clean = append(clean, M{"threshold": previous, "shares": n(row["shares"])})
		}
		r["teamLevels"] = clean
	}
	check(len(arr(r["teamLevels"])) == 0 || s(r["mode"]) == "team", "Buying levels require team packages")
	if b(r["continuous"]) {
		r["stopOnWin"] = false
	}
	for k, v := range payoutFields(merge(r, input)) {
		r[k] = v
	}
	return r
}
func spendEntries(o M) []M {
	rows := maps(o["spendHistory"])
	sum := int64(0)
	valid := len(rows) > 0
	for _, r := range rows {
		if !integer(moneyValue(r, "amountBtc")) || parseTime(r["at"]).IsZero() {
			valid = false
		}
		sum += money(r, "amountBtc")
	}
	if valid && sum == netCost(o) {
		return rows
	}
	return []M{spendEntry(paymentMarket(o), s(o["createdAt"]), netCost(o), "Purchase")}
}
func purchaseCount(o M) int64 {
	rows := maps(o["teamBuys"])
	if len(rows) == 0 {
		rows = []M{o}
	}
	var count int64
	for _, r := range rows {
		if !contains([]string{"FAILED", "REJECTED"}, s(r["status"])) {
			count++
		}
	}
	return count
}
func levelBuying(st M) bool { return s(st["mode"]) == "team" && len(arr(st["teamLevels"])) > 0 }
func nextLevel(pkg, st M, orders []M) M {
	if !levelBuying(st) {
		return nil
	}
	var owned M
	for _, o := range orders {
		if funded(o) && s(o["kind"]) == "team" && s(o["packageId"]) == s(pkg["id"]) {
			owned = o
			break
		}
	}
	if owned != nil && (s(owned["strategyId"]) != s(st["id"]) || !contains([]string{"ACTIVE", "PENDING"}, s(owned["status"])) || owned["accountingOverride"] != nil || owned["pendingTeamPurchase"] != nil || owned["syncPending"] != nil) {
		return nil
	}
	used := map[int64]bool{}
	for _, r := range maps(owned["teamBuys"]) {
		if !contains([]string{"FAILED", "REJECTED"}, s(r["status"])) {
			used[n(r["threshold"])] = true
		}
	}
	levels := maps(st["teamLevels"])
	if owned != nil && len(maps(owned["teamBuys"])) == 0 {
		used[n(levels[0]["threshold"])] = true
	}
	for _, l := range levels {
		if !used[n(l["threshold"])] {
			return merge(l, M{"parentOrderId": owned["id"]})
		}
	}
	return nil
}

const teamPath = "/main/api/v2/hashpower/shared/ticket/"
const soloPath = "/main/api/v2/hashpower/solo/order"

func rejectedTarget(orders []M, id string, profiles ...string) bool {
	return rejectedTargetReason(orders, id, profiles...) != ""
}

const teamStateRejectedReason = "NiceHash rejected the current team's state (code 5251); waiting for a different matching team"

func rejectedTargetReason(orders []M, id string, profiles ...string) string {
	profile := "documented"
	if len(profiles) > 0 {
		profile = purchaseProfile(M{"purchaseRequestProfile": profiles[0]})
	}
	reason := ""
	for _, o := range orders {
		if s(o["kind"]) != "team" || s(o["packageId"]) != id {
			continue
		}
		failures := []M{obj(o["lastTeamPurchaseFailure"]), obj(o["submissionFailure"])}
		for _, entry := range maps(o["teamBuys"]) {
			failures = append(failures, obj(entry["failure"]))
		}
		for _, f := range failures {
			// A state rejection belongs to the team, regardless of request format.
			// Retained pre-upgrade failures are recognized without rewriting the ledger.
			if teamStateRejectedFailure(f) && teamPurchaseTarget(s(f["path"])) == id {
				return teamStateRejectedReason
			}
			if !b(f["rejected"]) || (n(f["httpStatus"]) != 404 && n(f["httpStatus"]) != 410) || s(f["path"]) != teamPurchasePath(profile, id) {
				continue
			}
			// Old records without a format tag conservatively quarantine their same route.
			if s(f["purchaseRequestProfile"]) == "" || s(f["purchaseRequestProfile"]) == profile {
				reason = "NiceHash rejected the current team (HTTP 404/410); waiting for a different matching team"
			}
		}
	}
	return reason
}
func pickQuote(packages []M, st M, orders []M, profiles ...string) M {
	profile := "documented"
	if len(profiles) > 0 {
		profile = profiles[0]
	}
	choices := []M{}
	for _, p := range packages {
		if b(p["team"]) != (s(st["mode"]) == "team") || s(p["coin"]) != s(st["coin"]) || paymentMarket(p) != paymentMarket(st) {
			continue
		}
		if s(st["packageId"]) != "" {
			if s(p["id"]) != s(st["packageId"]) {
				continue
			}
		} else if s(st["packageName"]) != "" && !strings.EqualFold(s(p["name"]), s(st["packageName"])) {
			continue
		}
		if b(p["team"]) && rejectedTarget(orders, s(p["id"]), profile) {
			continue
		}
		q := clone(p)
		if levelBuying(st) {
			l := nextLevel(p, st, orders)
			if l == nil || (profile == "guide" && s(l["parentOrderId"]) != "") {
				continue
			}
			q["teamLevel"] = M{"threshold": l["threshold"], "shares": l["shares"]}
			q["parentOrderId"] = l["parentOrderId"]
			q["shares"] = l["shares"]
			setMoney(q, "costBtc", safeMul(money(p, "costBtc"), n(l["shares"])))
		} else {
			joined := false
			for _, o := range orders {
				if funded(o) && s(o["packageId"]) == s(p["id"]) {
					joined = true
				}
			}
			if b(p["team"]) && joined {
				continue
			}
			setMoney(q, "costBtc", safeMul(money(p, "costBtc"), map[bool]int64{true: n(st["shares"]), false: 1}[b(p["team"])]))
		}
		choices = append(choices, q)
	}
	if levelBuying(st) {
		sort.SliceStable(choices, func(i, j int) bool {
			return s(choices[i]["parentOrderId"]) != "" && s(choices[j]["parentOrderId"]) == ""
		})
		for _, p := range choices {
			if b(p["available"]) && n(p["teamShares"]) >= n(obj(p["teamLevel"])["threshold"]) {
				return p
			}
		}
	}
	for _, p := range choices {
		if b(p["available"]) {
			return p
		}
	}
	if len(choices) > 0 {
		return choices[0]
	}
	return nil
}
func window(at, start, end string) bool {
	if start <= end {
		return at >= start && at <= end
	}
	return at >= start || at <= end
}
func guard(state, st, q M, now time.Time, manual bool) string {
	settings := obj(state["settings"])
	market := paymentMarket(st)
	limits := marketLimits(settings, market)
	profile := purchaseProfile(settings)
	mode := s(settings["mode"])
	rt := obj(state["runtime"])
	orders := []M{}
	for _, o := range maps(state["orders"]) {
		if current(o) && s(o["mode"]) == mode {
			orders = append(orders, o)
		}
	}
	rewards := maps(state["rewards"])
	if !manual && !b(settings["running"]) {
		return "Engine is paused"
	}
	if !b(st["enabled"]) {
		return "Strategy is paused"
	}
	for _, o := range orders {
		if mode == "live" && held(o) {
			return "Imported purchase ownership is being verified; account sync will retry"
		}
	}
	if n(rt["errors"]) >= n(settings["maxErrors"]) {
		return "API error circuit breaker"
	}
	for _, o := range orders {
		if contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])) {
			return "Unresolved purchase: reconcile before buying"
		}
	}
	if mode == "live" && !b(settings["liveArmed"]) {
		return "Live buying is not armed"
	}
	for _, o := range orders {
		if mode == "live" && orderSyncBlocksBuying(o) {
			return "Waiting for NiceHash order details; account sync will retry"
		}
	}
	if mode == "live" && !b(rt["buyingReady"]) && ((manual && !b(rt["historyComplete"])) || rt["historyComplete"] == false) {
		return "Account history is incomplete; review sync warnings before buying"
	}
	if mode == "live" && (parseTime(rt["lastSync"]).IsZero() || now.Sub(parseTime(rt["lastSync"])) > 180*time.Second) {
		return "Account data is stale"
	}
	loc, e := time.LoadLocation(s(settings["timezone"]))
	if e != nil {
		return "Invalid timezone"
	}
	local := now.In(loc)
	dayOK := false
	for _, d := range arr(st["days"]) {
		if n(d) == int64(local.Weekday()) {
			dayOK = true
		}
	}
	if !dayOK || !window(local.Format("15:04"), s(settings["startHour"]), s(settings["endHour"])) || !window(local.Format("15:04"), s(st["startHour"]), s(st["endHour"])) {
		return "Outside buying schedule"
	}
	if q == nil || !b(q["available"]) {
		if q == nil {
			for _, p := range maps(state["packages"]) {
				if s(st["mode"]) == "team" && b(p["team"]) && s(p["coin"]) == s(st["coin"]) && (s(st["packageId"]) == "" || s(st["packageId"]) == s(p["id"])) && (s(st["packageName"]) == "" || s(st["packageId"]) != "" || strings.EqualFold(s(st["packageName"]), s(p["name"]))) && rejectedTarget(orders, s(p["id"]), profile) {
					return rejectedTargetReason(orders, s(p["id"]), profile)
				}
			}
			if profile == "guide" && levelBuying(st) {
				for _, p := range maps(state["packages"]) {
					if s(st["mode"]) == "team" && b(p["team"]) && s(p["coin"]) == s(st["coin"]) && (s(st["packageId"]) == "" || s(st["packageId"]) == s(p["id"])) && (s(st["packageId"]) != "" || s(st["packageName"]) == "" || strings.EqualFold(s(st["packageName"]), s(p["name"]))) {
						if l := nextLevel(p, st, orders); l != nil && s(l["parentOrderId"]) != "" {
							return "The guide shares-only format supports first joins; cumulative additions require the documented or web format"
						}
					}
				}
			}
			if levelBuying(st) {
				return "No current team has an unfilled buying level"
			}
		}
		return "Package unavailable"
	}
	if mode == "live" && b(q["team"]) && rejectedTarget(orders, s(q["id"]), profile) {
		if reason := rejectedTargetReason(orders, s(q["id"]), profile); reason == teamStateRejectedReason {
			return reason
		}
		return "This team lobby was rejected as unavailable; choose a current matching team"
	}
	if parseTime(q["quotedAt"]).IsZero() || now.Sub(parseTime(q["quotedAt"])) > 120*time.Second {
		return "Package quote is stale"
	}
	if !supportedMarket(s(q["market"])) || paymentMarket(q) != market {
		return "Package payment market does not match the strategy"
	}
	if n(limits["dailyCap"]) <= 0 || n(limits["maxOrder"]) <= 0 {
		return market + " spending limits are not configured"
	}
	cost := money(q, "costBtc")
	if !integer(moneyValue(q, "costBtc")) || cost <= 0 {
		return "Invalid package price"
	}
	reserved := reserve(cost, settings)
	if cost > n(st["maxPrice"]) || reserved > n(limits["maxOrder"]) {
		return "Price exceeds purchase ceiling"
	}
	var count, ownSpend, active, daySpend, weekSpend, monthSpend int64
	own := map[string]bool{}
	week := local.AddDate(0, 0, -(int(local.Weekday())+6)%7).Format("2006-01-02")
	parentPending := false
	for _, o := range orders {
		if pending(o) {
			active++
		}
		if s(o["id"]) == s(q["parentOrderId"]) && pending(o) {
			parentPending = true
		}
		if !funded(o) {
			continue
		}
		if paymentMarket(o) != market {
			continue
		}
		if s(o["strategyId"]) == s(st["id"]) {
			count += purchaseCount(o)
			ownSpend += netCost(o)
			own[s(o["id"])] = true
		}
		for _, entry := range spendEntries(o) {
			d := parseTime(entry["at"]).In(loc).Format("2006-01-02")
			amount := money(entry, "amountBtc")
			if d == local.Format("2006-01-02") {
				daySpend += amount
			}
			if d >= week {
				weekSpend += amount
			}
			if strings.HasPrefix(d, local.Format("2006-01")) {
				monthSpend += amount
			}
		}
	}
	if !b(st["continuous"]) && count >= n(st["maxPurchases"]) {
		return "Purchase count reached"
	}
	if !b(st["continuous"]) && ownSpend+reserved > n(st["budget"]) {
		return "Strategy budget reached"
	}
	if active >= n(settings["maxActive"]) && !parentPending {
		return "Concurrent package limit"
	}
	if daySpend+reserved > n(limits["dailyCap"]) {
		return "Daily spending cap"
	}
	if weekSpend+reserved > n(limits["weeklyCap"]) {
		return "Weekly spending cap"
	}
	if monthSpend+reserved > n(limits["monthlyCap"]) {
		return "Monthly spending cap"
	}
	t := totals(orders, rewards, mode, market)
	if n(limits["stopLoss"]) > 0 && n(t["net"]) <= -n(limits["stopLoss"]) {
		return "Stop loss reached"
	}
	if n(limits["takeProfit"]) > 0 && n(t["net"]) >= n(limits["takeProfit"]) {
		return "Take profit reached"
	}
	if mode == "live" && n(t["unpriced"]) > 0 {
		return "Unvalued confirmed rewards: reconcile accounting"
	}
	available := marketBalance(rt, market)
	if mode == "paper" {
		available = n(limits["paperBalance"]) - n(t["spend"]) + n(t["earned"])
	}
	if !integer(available) || n(available)-reserved < n(limits["reserve"]) {
		return "Minimum wallet reserve"
	}
	if !parseTime(st["lastBuyAt"]).IsZero() && now.Sub(parseTime(st["lastBuyAt"])) < time.Duration(n(st["intervalMinutes"]))*time.Minute {
		return "Waiting for next interval"
	}
	if !b(st["continuous"]) && b(st["stopOnWin"]) {
		for _, r := range rewards {
			if rewardAccounted(r) && b(r["confirmed"]) && n(r["amount"]) > 0 && own[s(r["orderId"])] {
				return "Stopped after a confirmed reward"
			}
		}
	}
	if s(st["kind"]) == "odds" && (f(q["odds"]) <= 0 || f(q["odds"]) > f(st["maxOdds"])) {
		return "Probability threshold not met"
	}
	if profile == "guide" && s(q["parentOrderId"]) != "" {
		return "The guide shares-only format supports first joins; cumulative additions require the documented or web format"
	}
	if levelBuying(st) {
		l := nextLevel(q, st, orders)
		if l == nil || n(l["threshold"]) != n(obj(q["teamLevel"])["threshold"]) || n(l["shares"]) != n(q["shares"]) || s(l["parentOrderId"]) != s(q["parentOrderId"]) {
			return "Team buying level changed; evaluate again"
		}
		if q["teamShares"] == nil || n(q["teamShares"]) < n(l["threshold"]) {
			return "Waiting for " + s(l["threshold"]) + " joined team shares · buy " + s(l["shares"]) + " additional share(s)"
		}
		for _, o := range orders {
			if s(o["id"]) == s(q["parentOrderId"]) {
				for _, k := range []string{"payoutAddress", "mergePayoutAddress"} {
					if s(st[k]) != "" && s(st[k]) != s(o[k]) {
						return "Payout destination changed; use a new team for this strategy"
					}
				}
			}
		}
	} else if s(st["mode"]) == "team" {
		if q["teamShares"] == nil || n(q["teamShares"]) < n(st["minTeamShares"]) {
			return "Waiting for team share threshold"
		}
		for _, o := range orders {
			if funded(o) && s(o["packageId"]) == s(q["id"]) {
				return "Already joined this team"
			}
		}
	}
	return ""
}
func totals(orders, rewards []M, mode string, markets ...string) M {
	market := "BTC"
	if len(markets) > 0 {
		market = markets[0]
	}
	orders, rewards = ledgerProjection(orders, rewards, market)
	var spend, earned, pendingValue, unpriced int64
	ids := map[string]bool{}
	for _, o := range orders {
		if accounted(o) && s(o["mode"]) == mode {
			ids[s(o["id"])] = true
			if funded(o) {
				spend += netCost(o)
			}
		}
	}
	for _, r := range rewards {
		if !rewardAccounted(r) || !ids[s(r["orderId"])] {
			continue
		}
		if b(r["confirmed"]) {
			if integer(r["valueBtc"]) {
				earned += n(r["valueBtc"])
			} else {
				unpriced++
			}
		} else if integer(r["valueBtc"]) {
			pendingValue += n(r["valueBtc"])
		}
	}
	return M{"spend": spend, "earned": earned, "pending": pendingValue, "net": earned - spend, "unpriced": unpriced}
}
func normalizeStatus(v any) string {
	raw := status(v)
	switch raw {
	case "ACTIVE", "CREATED":
		return "ACTIVE"
	case "WAITING", "COUNTDOWN", "SPAWNING", "PENDING", "PENDING_CANCELLATION":
		return "PENDING"
	case "COMPLETED", "EXPIRED", "DEAD":
		return "COMPLETED"
	}
	return "UNKNOWN"
}
func max(a, c int64) int64 {
	if a > c {
		return a
	}
	return c
}
func round(v float64) int64 {
	check(!math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) <= float64(MaxSafe), "Amount exceeds safe ledger precision")
	return int64(math.Floor(v + 0.5))
}
