package controller

import (
	"strings"
	"time"
)

func configurationBackup(state M) M {
	settings := clone(obj(state["settings"]))
	settings["running"] = false
	settings["liveArmed"] = false
	strategies := []M{}
	for _, st := range maps(state["strategies"]) {
		keys := []string{"id", "payoutAddress", "mergePayoutAddress"}
		for k := range defaultStrategy() {
			keys = append(keys, k)
		}
		strategies = append(strategies, pick(st, keys))
	}
	return M{"kind": "fastpool-easymining-settings", "schemaVersion": 1, "version": Version, "exportedAt": stamp(), "settings": settings, "strategies": strategies}
}
func (e *Engine) Import(backup, options M) M {
	restoreSettings := options["restoreSettings"] != false
	restoreStrategies := options["restoreStrategies"] != false
	mode := strfirst(options["strategyMode"], "merge")
	check(mode == "merge" || mode == "replace", "Choose a valid strategy import method")
	check(restoreSettings || restoreStrategies, "Select settings or strategies to import")
	if s(backup["kind"]) == "fastpool-easymining-settings" {
		check(n(backup["schemaVersion"]) == 1, "Unsupported settings format version")
	}
	settings := obj(e.Store.Get("settings"))
	if restoreSettings {
		raw, ok := backup["settings"].(map[string]any)
		check(ok && len(raw) > 0, "This export has no valid software settings")
		settings = validateSettings(raw, defaultSettings())
	}
	settings["running"] = false
	settings["liveArmed"] = false
	strategies := []M{}
	if restoreStrategies {
		raw, ok := backup["strategies"].([]any)
		check(ok && len(raw) <= 1000, "Expected up to 1,000 strategies")
		seen := map[string]bool{}
		for _, value := range raw {
			input, ok := value.(map[string]any)
			check(ok && has(input, "name"), "Expected a named strategy")
			st := validateStrategy(merge(input, M{"enabled": false}), defaultStrategy())
			id := s(input["id"])
			if id == "" {
				id = uuid()
			}
			check(len(id) <= 160 && !seen[id] && !strings.ContainsAny(id, "\x00\r\n"), "Invalid or duplicate strategy ID")
			seen[id] = true
			old := findBy(e.Store.List("strategies"), "id", id)
			if old != nil && paymentMarket(st) != paymentMarket(old) {
				for _, o := range e.Store.List("orders") {
					check(s(o["strategyId"]) != id || !funded(o), "Create a separate strategy to change the payment market after a purchase")
				}
			}
			st["id"] = id
			st["createdAt"] = first(old["createdAt"], input["createdAt"], stamp())
			var latest time.Time
			for _, v := range []any{input["lastBuyAt"], old["lastBuyAt"]} {
				if v != nil {
					t := parseTime(v)
					check(!t.IsZero(), "Invalid strategy lastBuyAt timestamp")
					if t.After(latest) {
						latest = t
					}
				}
			}
			for _, o := range e.Store.List("orders") {
				if s(o["strategyId"]) == id && funded(o) && parseTime(o["createdAt"]).After(latest) {
					latest = parseTime(o["createdAt"])
				}
			}
			st["lastBuyAt"] = nil
			if !latest.IsZero() {
				st["lastBuyAt"] = latest.UTC().Format(time.RFC3339Nano)
			}
			check(!parseTime(st["createdAt"]).IsZero(), "Invalid strategy createdAt timestamp")
			strategies = append(strategies, st)
		}
	}
	e.Store.Batch(func(tx *Store) {
		tx.Set("settings", settings)
		if restoreStrategies {
			if mode == "replace" {
				tx.Exec("DELETE FROM strategies")
			}
			for _, st := range strategies {
				tx.Save("strategies", st)
			}
		}
		tx.Exec("DELETE FROM kv WHERE key LIKE 'purchase-quote:%' AND json_extract(value,'$.orderId') IS NULL")
		tx.Event("warning", "Configuration imported; strategies paused and live buying disarmed")
	})
	return M{"ok": true, "importedStrategies": len(strategies), "settingsRestored": restoreSettings}
}
func resolveUnbought(o M, note string) {
	p := obj(o["pendingTeamPurchase"])
	check(len(p) > 0, "No pending team level to reconcile")
	buys := maps(o["teamBuys"])
	entry := findBy(buys, "requestId", p["requestId"])
	check(entry != nil, "No pending team attempt")
	if before := obj(p["before"]); len(before) > 0 {
		for _, k := range []string{"market", "costBtc", "feeBtc", "costAmount", "feeAmount", "shares", "status", "spendHistory", "rewardEstimate"} {
			if has(before, k) {
				o[k] = before[k]
			} else {
				delete(o, k)
			}
		}
	} else {
		o["status"] = "FAILED"
		setMoney(o, "feeBtc", 0)
		o["attemptedTeamId"] = o["externalId"]
		o["externalId"] = nil
	}
	entry["status"] = "REJECTED"
	entry["manualNoPurchase"] = M{"at": stamp(), "note": note}
	o["teamBuys"] = buys
	o["resolution"] = note
	for _, k := range []string{"pendingTeamPurchase", "error", "syncPending"} {
		delete(o, k)
	}
}
func diagnostics(state, connection M) M {
	state = merge(state, M{"connection": connection})
	failures := []M{}
	seen := map[string]bool{}
	for _, o := range maps(state["orders"]) {
		if s(o["kind"]) != "team" || s(o["mode"]) != "live" {
			continue
		}
		add := func(failure M, extra M) {
			if len(failure) == 0 {
				return
			}
			key := s(failure["requestId"])
			if key == "" {
				key = s(o["id"]) + ":" + s(failure["at"])
			}
			if seen[key] {
				return
			}
			seen[key] = true
			trace := pick(obj(failure["request"]), []string{"amount", "shares", "clear", "ticketId", "buyWithCurrency", "payloadBytes", "payloadSHA256", "payoutFieldNames"})
			failures = append(failures, merge(M{"orderId": o["id"], "debugTraceId": first(failure["debugTraceId"], o["debugTraceId"]), "teamId": o["packageId"], "orderStatus": o["status"], "teamCheck": first(failure["teamCheck"], o["purchaseCheck"]), "request": trace}, pick(failure, []string{"at", "rejected", "uncertain", "httpStatus", "code", "method", "path", "requestId", "providerErrorId", "purchaseRequestProfile"}), extra))
		}
		for _, entry := range maps(o["teamBuys"]) {
			add(obj(entry["failure"]), M{"levelThreshold": entry["threshold"], "levelStatus": entry["status"]})
		}
		add(obj(o["submissionFailure"]), nil)
		add(obj(o["lastTeamPurchaseFailure"]), nil)
		if len(failures) >= 20 {
			break
		}
	}
	decisions := []M{}
	strategies := []M{}
	for _, st := range maps(state["strategies"]) {
		orders := []M{}
		for _, o := range maps(state["orders"]) {
			if s(o["mode"]) == s(obj(state["settings"])["mode"]) {
				orders = append(orders, o)
			}
		}
		q := pickQuote(maps(state["packages"]), st, orders, purchaseProfile(obj(state["settings"])))
		reason := guard(state, st, q, time.Now(), false)
		decisions = append(decisions, M{"strategyId": st["id"], "mode": st["mode"], "eligible": reason == "", "reason": strfirst(reason, "Eligible by current guards; execution waits for engine cycle"), "selectedPackageId": q["id"]})
		if s(st["mode"]) == "team" {
			strategies = append(strategies, pick(st, []string{"id", "name", "market", "continuous", "coin", "packageName", "packageId", "enabled", "shares", "minTeamShares", "intervalMinutes", "maxPrice", "budget", "maxPurchases", "lastBuyAt", "teamLevels"}))
		}
	}
	return M{"version": Version, "runtimeLanguage": "Go", "exportedAt": stamp(), "connection": pick(connection, []string{"configured", "verified", "baseUrl", "source"}), "settings": pick(obj(state["settings"]), []string{"usdtLimits", "purchaseRequestProfile", "mode", "running", "liveArmed", "timezone", "dailyCap", "weeklyCap", "monthlyCap", "maxOrder", "reserve", "stopLoss", "takeProfit", "maxActive", "maxErrors"}), "runtime": syncDiagnostics(state), "syncIssues": syncIssues(state), "teamStrategies": strategies, "currentDecisions": decisions, "failures": failures, "note": "Sanitized purchase diagnostics, including pending sync references and reservations. Excludes credentials, organization ID, passwords, payout address values, 2FA, balances and full ledger. Export does not purchase or retry."}
}
