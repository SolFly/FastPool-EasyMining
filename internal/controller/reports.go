package controller

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"strings"
	"time"
)

func csvText(rows [][]string) string {
	var out bytes.Buffer
	w := csv.NewWriter(&out)
	w.UseCRLF = true
	for _, row := range rows {
		safe := append([]string{}, row...)
		for i, c := range safe {
			t := strings.TrimSpace(c)
			if len(t) > 0 && strings.ContainsAny(t[:1], "=+@-") {
				safe[i] = "'" + c
			}
		}
		must(w.Write(safe))
	}
	w.Flush()
	must(w.Error())
	return out.String()
}
func dailyReport(orders, rewards []M, mode, timezone string, days int, now time.Time, rates M, markets ...string) M {
	market := "BTC"
	if len(markets) > 0 {
		market = markets[0]
	}
	orders, rewards = ledgerProjection(orders, rewards, market)
	check(days >= 0 && days <= 3660, "Choose 0–3660 calendar days")
	loc, err := time.LoadLocation(timezone)
	check(err == nil, "Invalid timezone")
	local := now.In(loc)
	today := local.Format("2006-01-02")
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	from := start.AddDate(0, 0, 1-days)
	if days == 0 {
		from = time.Unix(0, 0)
	}
	buckets := map[string]M{}
	undated := 0
	empty := func(date string) M {
		return M{"date": date, "purchases": int64(0), "spend": int64(0), "earned": int64(0), "net": int64(0), "pending": int64(0), "unpriced": int64(0), "pendingUnpriced": int64(0), "legacyConfirmations": int64(0)}
	}
	bucket := func(v any) M {
		at := parseTime(v)
		if at.IsZero() {
			undated++
			return nil
		}
		if at.Before(from) || at.After(now) {
			return nil
		}
		key := at.In(loc).Format("2006-01-02")
		if buckets[key] == nil {
			buckets[key] = empty(key)
		}
		return buckets[key]
	}
	ids := map[string]bool{}
	for _, o := range orders {
		if !accounted(o) || s(o["mode"]) != mode {
			continue
		}
		ids[s(o["id"])] = true
		if !funded(o) {
			continue
		}
		for _, entry := range spendEntries(o) {
			if row := bucket(entry["at"]); row != nil {
				row["spend"] = n(row["spend"]) + money(entry, "amountBtc")
			}
		}
		buys := maps(o["teamBuys"])
		if len(buys) == 0 {
			buys = []M{o}
		}
		for _, buy := range buys {
			if contains([]string{"FAILED", "REJECTED"}, s(buy["status"])) {
				continue
			}
			if row := bucket(buy["createdAt"]); row != nil {
				row["purchases"] = n(row["purchases"]) + 1
			}
		}
	}
	for _, r := range rewards {
		if !ids[s(r["orderId"])] || !rewardAccounted(r) {
			continue
		}
		row := bucket(first(r["confirmedAt"], r["createdAt"]))
		if row == nil {
			continue
		}
		key := "pending"
		if b(r["confirmed"]) {
			key = "earned"
		}
		if integer(r["valueBtc"]) {
			row[key] = n(row[key]) + n(r["valueBtc"])
		} else {
			key = "pendingUnpriced"
			if b(r["confirmed"]) {
				key = "unpriced"
			}
			row[key] = n(row[key]) + 1
		}
		if b(r["confirmed"]) && r["confirmedAt"] == nil {
			row["legacyConfirmations"] = n(row["legacyConfirmations"]) + 1
		}
	}
	fromDate := from.In(loc).Format("2006-01-02")
	if days == 0 {
		fromDate = today
		for date := range buckets {
			if date < fromDate {
				fromDate = date
			}
		}
	}
	firstDay, err := time.ParseInLocation("2006-01-02", fromDate, loc)
	must(err)
	rows := []M{}
	total := empty("")
	for at := firstDay; !at.After(start); at = at.AddDate(0, 0, 1) {
		key := at.Format("2006-01-02")
		row := buckets[key]
		if row == nil {
			row = empty(key)
		}
		row["net"] = n(row["earned"]) - n(row["spend"])
		row["usd"] = fiatValue(n(row["net"]), market, "USD", rates)
		row["eur"] = fiatValue(n(row["net"]), market, "EUR", rates)
		for _, k := range []string{"purchases", "spend", "earned", "net", "pending", "unpriced", "pendingUnpriced", "legacyConfirmations"} {
			total[k] = n(total[k]) + n(row[k])
		}
		rows = append(rows, row)
	}
	total["usd"] = fiatValue(n(total["net"]), market, "USD", rates)
	total["eur"] = fiatValue(n(total["net"]), market, "EUR", rates)
	return M{"market": market, "fromDate": fromDate, "toDate": today, "timezone": timezone, "days": days, "mode": mode, "rows": rows, "total": total, "undated": undated, "to": now.UTC().Format(time.RFC3339Nano)}
}
func fiatCSV(value any) string {
	if value == nil {
		return "UNPRICED"
	}
	return fmt.Sprintf("%.2f", f(value))
}
func dailyCSV(report, rates M) string {
	rows := [][]string{{"Daily profit and loss", "Mode", s(report["mode"]), "Timezone", s(report["timezone"])}, {"From local date", s(report["fromDate"]), "Through local date", s(report["toDate"]), "As of", s(report["to"])}, {"Method", "Confirmed reward BTC value minus net package spend including reserved fees; pending rewards excluded"}, {"Dates", "Saved purchase/addition/refund times; first observed reward confirmation or legacy saved reward time"}, {"Fiat", "Current BTC spot estimates, not historical exchange proceeds", "Spot timestamp", s(rates["at"])}, {"Undated entries excluded", s(report["undated"])}, {"Date", "Purchases / team additions", "Net spend BTC", "Confirmed reward value BTC", "Net P&L BTC", "Net P&L USD estimate", "Net P&L EUR estimate", "Pending reward value BTC", "Unpriced confirmed rewards", "Unpriced pending rewards"}}
	add := func(label string, r M) {
		rows = append(rows, []string{label, s(r["purchases"]), decimal(n(r["spend"])), decimal(n(r["earned"])), decimal(n(r["net"])), fiatCSV(r["usd"]), fiatCSV(r["eur"]), decimal(n(r["pending"])), s(r["unpriced"]), s(r["pendingUnpriced"])})
	}
	for _, r := range maps(report["rows"]) {
		add(s(r["date"]), r)
	}
	add("TOTAL", obj(report["total"]))
	if market := s(report["market"]); market != "" && market != "BTC" {
		for i := range rows {
			for j := range rows[i] {
				rows[i][j] = strings.ReplaceAll(rows[i][j], "BTC", market)
			}
		}
	}
	return csvText(rows)
}
func ledgerCSV(state M, mode string, markets ...string) string {
	market := "BTC"
	if len(markets) > 0 {
		market = markets[0]
	}
	selected, valued := ledgerProjection(maps(state["orders"]), maps(state["rewards"]), market)
	state = merge(state, M{"orders": selected, "rewards": valued})
	rates := obj(obj(state["runtime"])["exchangeRates"])
	rows := [][]string{{"Order ID", "NiceHash ID", "Mode", "Package", "Coin", "Status", "Created", "Cost BTC", "Reserved fee BTC", "Refund BTC", "Source", "Payout address", "Merged reward coin", "Merged payout address", "Package type", "My shares", "Total team shares", "My team share percent"}}
	ids := map[string]bool{}
	orders := maps(state["orders"])
	for _, o := range orders {
		if !accounted(o) || s(o["mode"]) != mode {
			continue
		}
		ids[s(o["id"])] = true
		percent := ""
		if obj(o["rewardEstimate"])["fraction"] != nil {
			percent = fmt.Sprintf("%.8f", 100*f(obj(o["rewardEstimate"])["fraction"]))
		}
		rows = append(rows, []string{s(o["id"]), s(o["externalId"]), s(o["mode"]), s(o["name"]), s(o["coin"]), s(o["status"]), s(o["createdAt"]), decimal(money(o, "costBtc")), decimal(money(o, "feeBtc")), decimal(money(o, "refundBtc")), s(o["source"]), s(o["payoutAddress"]), s(o["mergeCoin"]), s(o["mergePayoutAddress"]), s(o["kind"]), s(o["shares"]), s(obj(o["rewardEstimate"])["totalShares"]), percent})
	}
	rows = append(rows, []string{}, []string{"Team buying level audit (already included in order totals)", "Order ID", "Threshold joined shares", "Additional shares", "Requested addition BTC", "Status", "Request ID", "Timestamp"})
	for _, o := range orders {
		if !ids[s(o["id"])] {
			continue
		}
		for _, entry := range maps(o["teamBuys"]) {
			rows = append(rows, []string{"Level attempt", s(o["id"]), s(entry["threshold"]), s(entry["shares"]), decimal(money(entry, "amountBtc")), s(entry["status"]), s(entry["requestId"]), s(entry["createdAt"])})
		}
	}
	rows = append(rows, []string{}, []string{"Reward ID", "Order ID", "Coin", "Amount", "Confirmed", "BTC accounting equivalent", "Valuation source", "Block/reward timestamp", "First observed confirmation", "Current USD estimate", "Current EUR estimate", "Spot timestamp"})
	coinTotals := map[string]M{}
	for _, coin := range []string{"BTC", "BCH", "LTC", "DOGE", "ZEC"} {
		coinTotals[coin] = M{"confirmed": int64(0), "pending": int64(0)}
	}
	for _, r := range maps(state["rewards"]) {
		if !ids[s(r["orderId"])] || !rewardAccounted(r) {
			continue
		}
		value := "UNPRICED"
		if integer(r["valueBtc"]) {
			value = decimal(n(r["valueBtc"]))
		}
		coin := s(r["coin"])
		rows = append(rows, []string{s(r["id"]), s(r["orderId"]), coin, decimal(n(r["amount"])), s(r["confirmed"]), value, s(r["valuation"]), s(r["createdAt"]), s(r["confirmedAt"]), fiatCSV(fiatValue(n(r["amount"]), coin, "USD", rates)), fiatCSV(fiatValue(n(r["amount"]), coin, "EUR", rates)), s(rates["at"])})
		if coinTotals[coin] == nil {
			coinTotals[coin] = M{}
		}
		key := "pending"
		if b(r["confirmed"]) {
			key = "confirmed"
		}
		coinTotals[coin][key] = n(coinTotals[coin][key]) + n(r["amount"])
	}
	rows = append(rows, []string{}, []string{"Coin totals (all time)", "Confirmed amount", "Pending amount", "Confirmed current USD estimate", "Confirmed current EUR estimate", "Spot timestamp"})
	for coin, r := range coinTotals {
		rows = append(rows, []string{coin, decimal(n(r["confirmed"])), decimal(n(r["pending"])), fiatCSV(fiatValue(n(r["confirmed"]), coin, "USD", rates)), fiatCSV(fiatValue(n(r["confirmed"]), coin, "EUR", rates)), s(rates["at"])})
	}
	for _, o := range orders {
		if current(o) && s(o["mode"]) == mode && held(o) {
			rows = append(rows, []string{"Excluded: ownership verification pending", strfirst(o["externalId"], o["id"]), s(obj(o["attribution"])["reason"])})
		}
	}
	if market != "BTC" {
		for i := range rows {
			for j := range rows[i] {
				rows[i][j] = strings.ReplaceAll(rows[i][j], " BTC", " "+market)
				if rows[i][j] == "BTC accounting equivalent" {
					rows[i][j] = market + " accounting equivalent"
				}
			}
		}
	}
	return csvText(rows)
}
