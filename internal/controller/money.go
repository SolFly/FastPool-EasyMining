package controller

import "math/big"

// Amounts use eight decimal places in their declared payment currency. BTC
// records keep their original field names; USDT never occupies a BTC cost field.
var paymentKeys = map[string]string{
	"costBtc": "costAmount", "feeBtc": "feeAmount", "refundBtc": "refundAmount",
	"requestedCostBtc": "requestedAmount", "amountBtc": "amount", "reservedBtc": "reservedAmount",
	"targetCostBtc": "targetAmount", "beforeCostBtc": "beforeAmount", "additionalCostBtc": "additionalAmount",
	"sharePriceBtc": "sharePriceAmount",
}

func paymentMarket(v M) string {
	if explicit := strfirst(v["currencyMarket"], obj(v["currencyAlgoTicket"])["currencyMarket"]); explicit != "" {
		return explicit
	}
	if m := s(v["market"]); supportedMarket(m) {
		return m
	}
	return "BTC"
}
func supportedMarket(m string) bool { return m == "BTC" || m == "USDT" }
func moneyValue(v M, key string) any {
	if paymentMarket(v) == "USDT" {
		return v[paymentKeys[key]]
	}
	return v[key]
}
func money(v M, key string) int64 { return n(moneyValue(v, key)) }
func setMoney(v M, key string, value any) {
	if paymentMarket(v) == "USDT" {
		v[paymentKeys[key]] = value
		delete(v, key)
	} else {
		v[key] = value
	}
}
func fundingRecord(market string, v M) M {
	check(supportedMarket(market), "Unsupported payment market")
	v["market"] = market
	if market == "USDT" {
		for old, next := range paymentKeys {
			if x, ok := v[old]; ok {
				v[next] = x
				delete(v, old)
			}
		}
	}
	return v
}
func spendEntry(market, at string, amount int64, note string) M {
	return fundingRecord(market, M{"at": at, "amountBtc": amount, "note": note})
}
func usdtLimits() M {
	// Zero caps leave a newly installed USDT ledger unconfigured until the owner
	// explicitly sets its bankroll limits. Enabling a catalogue is not arming it.
	return M{"dailyCap": int64(0), "weeklyCap": int64(0), "monthlyCap": int64(0), "maxOrder": int64(0), "reserve": int64(0), "stopLoss": int64(0), "takeProfit": int64(0), "paperBalance": int64(100 * Sat)}
}
func marketLimits(settings M, market string) M {
	if market == "USDT" {
		return merge(settings, usdtLimits(), obj(settings["usdtLimits"]))
	}
	return settings
}
func marketBalance(runtime M, market string) any {
	if market == "BTC" {
		return first(runtime["balance"], obj(runtime["balances"])["BTC"])
	}
	return obj(runtime["balances"])[market]
}
func rewardMarketValue(r M, market string) any {
	if market == "USDT" {
		return r["valueUsdt"]
	}
	return r["valueBtc"]
}
func usdtRewardValue(r M, rates M) {
	if (b(r["confirmed"]) && b(r["usdtValuationFrozen"]) || r["manualUsdtValuation"] != nil) && integer(r["valueUsdt"]) {
		return
	}
	if s(r["coin"]) == "USDT" {
		r["valueUsdt"] = r["amount"]
		return
	}
	r["valueUsdt"] = nil
	if !integer(r["valueBtc"]) {
		return
	}
	rate, ok := new(big.Rat).SetString(s(rates["USDT"]))
	if !ok || rate.Sign() <= 0 {
		return
	}
	x := new(big.Rat).Quo(new(big.Rat).SetInt64(n(r["valueBtc"])), rate)
	x.Add(x, big.NewRat(1, 2))
	value := new(big.Int).Quo(x.Num(), x.Denom())
	check(value.IsInt64() && value.Int64() <= MaxSafe, "Reward valuation exceeds safe ledger precision")
	r["valueUsdt"] = value.Int64()
	if b(r["confirmed"]) {
		r["usdtValuationFrozen"] = true
	}
	r["usdtValuation"] = "NiceHash account BTC/USDT rate when first valued; confirmed value is retained, not exchanged"
}

// Reuse the established reporting arithmetic with a temporary, currency-specific
// projection. This never changes stored records or mixes the two ledgers.
func ledgerProjection(orders, rewards []M, market string) ([]M, []M) {
	selected := []M{}
	ids := map[string]bool{}
	for _, o := range orders {
		if paymentMarket(o) != market {
			continue
		}
		v := clone(o)
		if market == "USDT" {
			for old, next := range paymentKeys {
				if x, ok := v[next]; ok {
					v[old] = x
				}
			}
			for _, e := range maps(v["spendHistory"]) {
				e["amountBtc"] = e["amount"]
			}
		}
		selected = append(selected, v)
		ids[s(o["id"])] = true
	}
	valued := []M{}
	for _, r := range rewards {
		if !ids[s(r["orderId"])] {
			continue
		}
		v := clone(r)
		if market == "USDT" {
			v["valueBtc"] = r["valueUsdt"]
			v["valuation"] = r["usdtValuation"]
		}
		valued = append(valued, v)
	}
	return selected, valued
}

func (a *App) migrateContinuousBuying() {
	if b(a.Store.Get("continuousBuyingV1")) {
		return
	}
	for _, st := range a.Store.List("strategies") {
		st["continuous"] = true
		st["stopOnWin"] = false
		if st["market"] == nil {
			st["market"] = "BTC"
		}
		a.Store.Save("strategies", st)
	}
	a.Store.Set("continuousBuyingV1", true)
	rt := obj(a.Store.Get("runtime"))
	rt["decisions"] = []M{}
	a.Store.Set("runtime", rt)
}
