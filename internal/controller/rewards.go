package controller

import (
	"math"
	"math/big"
	"strings"
)

func blockRewards(template M) []M {
	out := []M{}
	for _, k := range []string{"currencyAlgo", "mergeCurrencyAlgo"} {
		a := obj(template[k])
		if !coinRE.MatchString(s(a["currency"])) {
			continue
		}
		attempt(func() {
			amount := fromRational(rational(first(a["blockRewardWithNhFee"], a["blockReward"]), "block estimate"), false, "block estimate")
			out = append(out, M{"coin": a["currency"], "amount": amount})
		})
	}
	return out
}
func optionalUnits(v any) any {
	if v == nil {
		return nil
	}
	var out any
	attempt(func() { out = units(v, "team estimate") })
	return out
}
func estimate(blocks []M, team bool, member, total, memberShares, totalShares any, source string) M {
	num, den := int64(1), int64(1)
	known := true
	scope := "solo"
	if team {
		scope = "team-member"
		if integer(member) && n(member) > 0 && integer(total) && n(total) >= n(member) {
			num = n(member)
			den = n(total)
		} else if integer(memberShares) && n(memberShares) > 0 && integer(totalShares) && n(totalShares) >= n(memberShares) {
			num = n(memberShares)
			den = n(totalShares)
		} else {
			known = false
		}
	}
	out := []M{}
	for _, block := range blocks {
		var amount any
		if known && integer(block["amount"]) && n(block["amount"]) >= 0 {
			x := new(big.Int).Mul(big.NewInt(n(block["amount"])), big.NewInt(num))
			x.Quo(x, big.NewInt(den))
			amount = x.Int64()
		}
		out = append(out, M{"coin": block["coin"], "fullAmount": block["amount"], "amount": amount})
	}
	var fraction, note any
	if known {
		fraction = float64(num) / float64(den)
	} else {
		note = "Team contribution totals are unavailable. No personal block reward is assumed."
	}
	return M{"scope": scope, "source": source, "at": stamp(), "memberAmount": member, "totalAmount": total, "memberShares": memberShares, "totalShares": totalShares, "fraction": fraction, "blocks": out, "note": note}
}
func purchaseEstimate(pkg M, shares int64) M {
	blocks := maps(pkg["blockRewards"])
	if len(blocks) == 0 && s(pkg["mergeCoin"]) == "" {
		if amount := optionalUnits(pkg["reward"]); amount != nil {
			blocks = []M{{"coin": pkg["coin"], "amount": amount}}
		}
	}
	var member, total, teamShares any
	if integer(moneyValue(pkg, "costBtc")) {
		member = safeMul(money(pkg, "costBtc"), shares)
	}
	existing := pkg["teamCommitted"]
	if !integer(existing) && integer(pkg["teamShares"]) && integer(pkg["minShare"]) {
		existing = safeMul(n(pkg["teamShares"]), n(pkg["minShare"]))
	}
	if integer(existing) && integer(member) {
		total = n(existing) + n(member)
	}
	if integer(pkg["teamShares"]) {
		teamShares = n(pkg["teamShares"]) + shares
	}
	return estimate(blocks, b(pkg["team"]), member, total, shares, teamShares, "purchase snapshot")
}
func teamEstimate(raw, member M) M {
	p := obj(raw["currencyAlgoTicket"])
	memberAmount := optionalUnits(member["addedAmount"])
	total := optionalUnits(raw["addedAmount"])
	minimum := optionalUnits(first(raw["minShareAmount"], p["minShareAmount"], "0.0001"))
	var ownShares, totalShares any
	ownShares = obj(member["shares"])["small"]
	totalShares = raw["totalShares"]
	if n(minimum) > 0 {
		if integer(memberAmount) && n(memberAmount)%n(minimum) == 0 {
			ownShares = n(memberAmount) / n(minimum)
		}
		if integer(total) && n(total)%n(minimum) == 0 {
			totalShares = n(total) / n(minimum)
		}
	}
	return estimate(blockRewards(p), true, memberAmount, total, ownShares, totalShares, "verified account member")
}
func normalizeRates(raw M) M {
	_, ok := raw["list"].([]any)
	check(ok, "Unexpected exchange-rate response")
	pairs := map[string]float64{}
	coins := []string{"BTC", "BCH", "LTC", "DOGE", "ZEC", "USDT"}
	for _, r := range maps(raw["list"]) {
		rate := f(r["exchangeRate"])
		if rate <= 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
			continue
		}
		pairs[s(r["fromCurrency"])+"/"+s(r["toCurrency"])] = rate
		if !contains(coins, s(r["fromCurrency"])) {
			coins = append(coins, s(r["fromCurrency"]))
		}
	}
	direct := func(from, to string) float64 {
		if from == to {
			return 1
		}
		if r := pairs[from+"/"+to]; r > 0 {
			return r
		}
		if r := pairs[to+"/"+from]; r > 0 {
			return 1 / r
		}
		return 0
	}
	var route func(string, string, int, map[string]bool) float64
	route = func(from, to string, depth int, seen map[string]bool) float64 {
		if value := direct(from, to); value > 0 {
			return value
		}
		if depth == 0 {
			return 0
		}
		for _, via := range []string{"USD", "BTC", "USDT", "EUR"} {
			if seen[via] {
				continue
			}
			first := direct(from, via)
			if first <= 0 {
				continue
			}
			next := map[string]bool{}
			for k, v := range seen {
				next[k] = v
			}
			next[via] = true
			value := first * route(via, to, depth-1, next)
			if value > 0 && !math.IsInf(value, 0) && !math.IsNaN(value) {
				return value
			}
		}
		return 0
	}
	rate := func(from, to string) float64 { return route(from, to, 2, map[string]bool{from: true}) }

	fiat := M{"USD": M{}, "EUR": M{}}
	btc := M{"BTC": 1}
	for _, c := range coins {
		for _, fi := range []string{"USD", "EUR"} {
			if r := rate(c, fi); r > 0 {
				obj(fiat[fi])[c] = r
			}
		}
		if r := rate(c, "BTC"); r > 0 {
			btc[c] = r
		}
	}
	return M{"at": stamp(), "source": "NiceHash exchangeRate/list", "fiat": fiat, "btc": btc}
}
func fiatValue(amount int64, coin, currency string, rates M) any {
	r := f(obj(obj(rates["fiat"])[currency])[coin])
	if r <= 0 {
		return nil
	}
	return float64(amount) / float64(Sat) * r
}
func membership(raw M, org string) (M, string) {
	members := maps(raw["members"])
	if keyed, ok := raw["members"].(map[string]any); ok {
		members = []M{}
		for key, v := range keyed {
			m := clone(obj(v))
			if s(m["organizationId"]) == "" {
				m["organizationId"] = key
			}
			members = append(members, m)
		}
	}
	redacted := false
	for _, m := range members {
		id := strfirst(obj(m["organizationId"])["id"], m["organizationId"], obj(m["organization"])["id"])
		if id != "" && strings.EqualFold(id, org) {
			return m, "owned"
		}
		if id == "" && f(m["addedAmount"]) > 0 {
			redacted = true
		}
	}
	if f(raw["myAddedAmount"]) > 0 || redacted {
		return nil, "unattributed"
	}
	if len(members) > 0 {
		return nil, "unrelated"
	}
	return nil, "unjoined"
}
func providerRewardRows(v any, depth int) []M {
	out := []M{}
	if depth > 8 {
		return out
	}
	for _, r := range maps(v) {
		out = append(out, r)
		out = append(out, providerRewardRows(r["groupedRewards"], depth+1)...)
	}
	return out
}
func teamReference(raw M) M {
	id := func(v any) string { return strfirst(obj(v)["id"], v) }
	if raw["sharedTicket"] != nil && raw["sharedTicket"] != false {
		embedded := id(raw["sharedTicket"])
		check(uuidRE.MatchString(embedded), "Team account entry has an invalid sharedTicket object")
		check(s(raw["sharedTicketId"]) == "" || id(raw["sharedTicketId"]) == embedded, "Conflicting team IDs in account entry")
		return M{"teamId": embedded, "explicit": true, "embedded": raw["sharedTicket"]}
	}
	if raw["sharedTicketId"] != nil {
		teamID := id(raw["sharedTicketId"])
		check(uuidRE.MatchString(teamID), "Team account entry has an invalid sharedTicketId")
		return M{"teamId": teamID, "explicit": true}
	}
	if raw["myAddedAmount"] != nil && units(raw["myAddedAmount"], "myAddedAmount") > 0 {
		return M{"teamId": raw["id"], "explicit": false}
	}
	refs := []any{}
	shared := false
	for _, r := range providerRewardRows(raw["soloReward"], 0) {
		if b(r["shared"]) {
			shared = true
			refs = addUnique(refs, r["packageId"])
		}
	}
	if shared {
		check(len(refs) <= 1, "Shared rewards reference several teams; attribution requires review")
		var teamID any
		if len(refs) > 0 {
			teamID = refs[0]
		}
		return M{"teamId": teamID, "explicit": true, "rewardReference": true}
	}
	return nil
}
func soloProof(raw M, org string) string {
	owner := s(raw["organizationId"])
	if owner != "" {
		if strings.EqualFold(owner, org) {
			return "own organization on private order"
		}
		return ""
	}
	if has(raw, "sharedTicket") && (raw["sharedTicket"] == nil || raw["sharedTicket"] == false) {
		return "private order explicitly has no shared ticket"
	}
	rewards := providerRewardRows(raw["soloReward"], 0)
	if len(rewards) > 0 {
		for _, r := range rewards {
			if r["shared"] != false {
				return ""
			}
		}
		return "provider marks every reward as personal solo"
	}
	return ""
}
func automatic(o M) bool {
	return s(o["source"]) == "NiceHash import" && s(o["requestId"]) == "" && s(o["strategyId"]) == "" && o["accountingOverride"] == nil
}
func editedReward(r M) bool {
	if r["manualUsdtValuation"] != nil {
		return true
	}
	return r["manualConfirmed"] != nil || strings.HasPrefix(s(r["valuation"]), "Manual valuation:")
}
func findBy(rows []M, key string, value any) M {
	if s(value) == "" {
		return nil
	}
	for _, r := range rows {
		if s(r[key]) == s(value) {
			return r
		}
	}
	return nil
}
func includes(a []any, value any) bool {
	for _, v := range a {
		if s(v) == s(value) {
			return true
		}
	}
	return false
}
