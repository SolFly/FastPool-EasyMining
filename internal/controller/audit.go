package controller

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Audit is deliberately incapable of issuing a provider POST. Each probe uses
// Get and returns a strict whitelist, never the original private response.
func (e *Engine) Audit(ctx context.Context, connection M) M {
	return obj(e.exclusive(func(string) any {
		ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		report := M{"kind": "fastpool-easymining-api-audit", "version": Version, "exportedAt": stamp(), "readOnly": true, "connection": pick(connection, []string{"configured", "verified", "baseUrl", "source"}), "probes": []M{}, "purchasePlans": []M{}, "ledger": ledgerAudit(e.Store.State()), "note": "GET-only provider probes. No purchase, retry, arming or configuration change. Financial totals, team/order IDs and provider error references are included; credentials, organization IDs, payout addresses, 2FA and raw private responses are excluded. History probes sample the first page only."}
		api := e.Client()
		probes := []M{}
		probe := func(path string, query url.Values, private bool, summarize func(any) M) M {
			row := M{"method": "GET", "path": path, "private": private, "checkedAt": stamp()}
			if len(query) > 0 {
				row["query"] = query.Encode()
			}
			var summary M
			caught := attempt(func() { raw := api.Get(ctx, path, query, private); summary = summarize(raw) })
			if caught == nil {
				row["httpStatus"] = 200
				row["summary"] = summary
			} else if upstream, ok := caught.(*APIError); ok {
				row["httpStatus"] = upstream.HTTPStatus
				row["code"] = upstream.Code
				row["providerErrorId"] = upstream.ProviderErrorID
				row["requestId"] = upstream.RequestID
				row["outcome"] = "Provider rejected the read or its response could not be read"
			} else {
				row["outcome"] = "Response schema or numerical fields could not be validated"
			}
			probes = append(probes, row)
			return summary
		}
		clockBegin := time.Now().UnixMilli()
		probe("/api/v2/time", nil, false, func(raw any) M {
			d := obj(raw)
			check(integer(d["serverTime"]), "Invalid clock response")
			api.Offset = n(d["serverTime"]) - (clockBegin+time.Now().UnixMilli())/2
			return M{"serverTime": d["serverTime"]}
		})
		var packages []M
		probe("/main/api/v2/public/solo/package", nil, false, func(raw any) M {
			_, ok := raw.([]any)
			check(ok, "Invalid catalogue")
			byMarket := M{}
			for _, p := range maps(raw) {
				market := strfirst(p["currencyMarket"], "BTC")
				byMarket[market] = n(byMarket[market]) + 1
				packages = append(packages, normalizePackage(p, stamp(), false))
			}
			return M{"count": len(maps(raw)), "byMarket": byMarket}
		})
		rawTeams := []M{}
		probe("/main/api/v2/public/solo/shared/order", url.Values{"onlyGold": {"false"}, "page": {"0"}, "limit": {"100"}}, false, func(raw any) M {
			root := obj(raw)
			_, ok := root["list"].([]any)
			check(ok, "Invalid team catalogue")
			rows := []M{}
			rawTeams = maps(root["list"])
			for _, t := range rawTeams {
				q := normalizePackage(t, stamp(), true)
				packages = append(packages, q)
				rows = append(rows, merge(teamSnapshot(q), M{"templateId": obj(t["currencyAlgoTicket"])["id"], "durationSeconds": q["duration"], "templateDurationSeconds": obj(t["currencyAlgoTicket"])["duration"]}))
			}
			return M{"count": len(rows), "teams": rows}
		})
		var spot M
		probe("/main/api/v2/exchangeRate/list", nil, false, func(raw any) M {
			spot = normalizeRates(obj(raw))
			return pick(spot, []string{"at", "source", "fiat", "btc"})
		})
		if b(connection["configured"]) {
			probe("/main/api/v2/accounting/accounts2", url.Values{"extendedResponse": {"true"}, "fiat": {"USD"}}, true, func(raw any) M {
				_, ok := obj(raw)["currencies"].([]any)
				check(ok, "Invalid balances")
				currencies := []M{}
				for _, c := range maps(obj(raw)["currencies"]) {
					if contains([]string{"BTC", "BCH", "LTC", "DOGE", "ZEC"}, s(c["currency"])) {
						currencies = append(currencies, M{"coin": c["currency"], "availableAmountValid": attempt(func() { units(c["available"], "available balance") }) == nil, "btcRate": optionalPositiveRate(c["btcRate"])})
					}
				}
				return M{"currencies": currencies, "balanceAmountsOmitted": true}
			})
			for _, team := range []bool{false, true} {
				path := api.TicketListPath(team)
				query := url.Values{"page": {"0"}, "limit": {"100"}}
				if team {
					query.Set("onlyGold", "false")
				}
				probe(path, query, true, func(raw any) M {
					root := obj(raw)
					_, ok := root["list"].([]any)
					check(ok, "Invalid account index")
					stats := M{"returnedRows": len(maps(root["list"])), "sampleOnly": true, "ownMemberRows": 0, "unattributedRows": 0, "sharedReferences": 0, "otherPaymentCurrencyRows": 0}
					for _, row := range maps(root["list"]) {
						if team {
							_, ownership := membership(row, s(api.Credentials["orgId"]))
							if ownership == "owned" {
								stats["ownMemberRows"] = n(stats["ownMemberRows"]) + 1
							}
							if ownership == "unattributed" {
								stats["unattributedRows"] = n(stats["unattributedRows"]) + 1
							}
						} else {
							attempt(func() {
								if teamReference(row) != nil {
									stats["sharedReferences"] = n(stats["sharedReferences"]) + 1
								}
							})
						}
						market := strfirst(row["currencyMarket"], obj(row["currencyAlgoTicket"])["currencyMarket"])
						if market != "" && market != "BTC" {
							stats["otherPaymentCurrencyRows"] = n(stats["otherPaymentCurrencyRows"]) + 1
						}
					}
					return stats
				})
			}
			probe(purchasePrefix(api.PurchaseProfile)+"/api/v2/hashpower/sharedTicketExternalAddress/list", nil, true, func(raw any) M {
				_, ok := raw.([]any)
				check(ok, "Invalid address response")
				byCoin := M{}
				for _, a := range maps(raw) {
					coin := s(a["currency"])
					if coinRE.MatchString(coin) {
						byCoin[coin] = n(byCoin[coin]) + 1
					}
				}
				return M{"count": len(maps(raw)), "byCoin": byCoin, "addressValuesOmitted": true}
			})
			selected := []string{}
			for _, st := range e.Store.List("strategies") {
				if !b(st["enabled"]) || s(st["mode"]) != "team" {
					continue
				}
				for _, raw := range rawTeams {
					p := normalizePackage(raw, stamp(), true)
					if paymentMarket(p) == paymentMarket(st) && s(p["coin"]) == s(st["coin"]) && (s(st["packageId"]) == "" || s(p["id"]) == s(st["packageId"])) && (s(st["packageId"]) != "" || s(st["packageName"]) == "" || s(st["packageName"]) == s(p["name"])) {
						if !contains(selected, s(p["id"])) {
							selected = append(selected, s(p["id"]))
						}
						break
					}
				}
				if len(selected) >= 4 {
					break
				}
			}
			// Same signed GET on both namespaces is a diagnostic comparison only. It
			// never selects a purchase route or authorizes submitting to another route.
			for _, id := range selected {
				for _, prefix := range []string{"/main", "/hashpower"} {
					probe(prefix+"/api/v2/hashpower/solo/shared/order/"+id, nil, true, func(raw any) M {
						d := obj(raw)
						check(s(d["id"]) == id, "Different team ID")
						member, ownership := membership(d, s(api.Credentials["orgId"]))
						q := normalizePackage(d, stamp(), true)
						summary := merge(teamSnapshot(q), M{"membership": ownership, "templateId": obj(d["currencyAlgoTicket"])["id"], "durationSeconds": q["duration"], "executionId": obj(d["orderDetails"])["id"]})
						if member != nil {
							key := "personalCostBtc"
							if paymentMarket(q) == "USDT" {
								key = "personalCostAmount"
							}
							summary[key] = units(member["addedAmount"], "own member contribution")
							summary["personalShares"] = obj(member["shares"])["small"]
							summary["paymentStatus"] = member["paymentStatus"]
							summary["claimed"] = member["claimed"]
							rewards := []M{}
							for _, r := range maps(member["rewards"]) {
								rewards = append(rewards, pick(r, []string{"coin", "currency", "rewardAmount", "rewardFeeAmount"}))
							}
							summary["personalRewards"] = rewards
						}
						return summary
					})
				}
			}
		}
		plans := []M{}
		orders := e.Store.List("orders")
		mode := s(obj(e.Store.Get("settings"))["mode"])
		activeOrders := []M{}
		for _, o := range orders {
			if s(o["mode"]) == mode {
				activeOrders = append(activeOrders, o)
			}
		}
		state := e.Store.State()
		state["packages"] = packages
		for _, st := range e.Store.List("strategies") {
			if s(st["mode"]) != "team" {
				continue
			}
			q := pickQuote(packages, st, activeOrders, purchaseProfile(obj(state["settings"])))
			row := M{"strategyId": st["id"], "levelsEnabled": levelBuying(st), "selectedTeamId": q["id"], "currentDecision": guard(state, st, q, time.Now(), false)}
			// A quarantined target still needs an inspectable body comparison.
			// These references never participate in selection or authorization.
			references := []M{}
			for _, p := range packages {
				if !b(p["team"]) || s(p["market"]) != "BTC" || s(p["coin"]) != s(st["coin"]) {
					continue
				}
				if s(st["packageId"]) != "" {
					if s(st["packageId"]) != s(p["id"]) {
						continue
					}
				} else if s(st["packageName"]) != "" && s(st["packageName"]) != s(p["name"]) {
					continue
				}
				ordinaryShares := n(st["shares"])
				firstShares := ordinaryShares
				if levelBuying(st) {
					firstShares = n(maps(st["teamLevels"])[0]["shares"])
				}
				ordinary := api.TeamBody(fundingRecord(paymentMarket(p), merge(p, M{"costBtc": safeMul(money(p, "costBtc"), ordinaryShares)})), M{"shares": ordinaryShares}, nil, nil)
				level := api.TeamBody(fundingRecord(paymentMarket(p), merge(p, M{"costBtc": safeMul(money(p, "costBtc"), firstShares)})), M{"shares": firstShares}, nil, nil)
				references = append(references, M{"teamId": p["id"], "quarantined": rejectedTarget(activeOrders, s(p["id"]), api.PurchaseProfile), "referenceOnly": true, "payoutFieldsOmitted": true, "ordinaryJoin": decode(encode(ordinary)), "firstLevelJoin": decode(encode(level)), "bodiesEqual": string(encode(ordinary)) == string(encode(level))})
				if len(references) >= 3 {
					break
				}
			}
			row["joinReferences"] = references
			if q != nil {
				shares := first(q["shares"], st["shares"])
				row["additionalShares"] = shares
				row["additionalCostBtc"] = moneyValue(q, "costBtc")
				row["route"] = api.TeamBuyPath(s(q["id"]))
				if s(q["parentOrderId"]) == "" {
					body := api.TeamBody(q, merge(st, M{"shares": shares}), nil, nil)
					row["firstJoinBodyWithoutPayout"] = decode(encode(body))
					row["usesOwnedAdditionPreflight"] = false
				} else {
					before := findBy(orders, "id", q["parentOrderId"])
					row["priorShares"] = before["shares"]
					row["priorCostBtc"] = moneyValue(before, "costBtc")
					row["desiredCumulativeShares"] = n(before["shares"]) + n(shares)
					row["desiredCumulativeCostBtc"] = money(before, "costBtc") + money(q, "costBtc")
					row["usesOwnedAdditionPreflight"] = true
				}
			}
			row["market"] = paymentMarket(st)
			if paymentMarket(st) == "USDT" {
				for k, v := range row {
					if strings.HasSuffix(k, "Btc") {
						row[strings.TrimSuffix(k, "Btc")+"Amount"] = v
						delete(row, k)
					}
				}
			}
			plans = append(plans, row)
		}
		report["paymentLedgers"] = M{"BTC": ledgerAudit(e.Store.State(), "BTC"), "USDT": ledgerAudit(e.Store.State(), "USDT")}
		report["purchaseRequestProfile"] = api.PurchaseProfile
		report["probes"] = probes
		report["purchasePlans"] = plans
		report["spotRates"] = spot
		report["purchaseFailures"] = obj(diagnostics(e.Store.State(), connection))["failures"]
		report["completedAt"] = stamp()
		report["timedOut"] = ctx.Err() != nil
		return report
	}))
}
func ledgerAudit(state M, markets ...string) M {
	market := "BTC"
	if len(markets) > 0 {
		market = markets[0]
	}
	settings := obj(state["settings"])
	mode := s(settings["mode"])
	orders := maps(state["orders"])
	rewards := maps(state["rewards"])
	orders, rewards = ledgerProjection(orders, rewards, market)
	summary := totals(orders, rewards, mode, market)
	coins := M{}
	for _, coin := range []string{"BTC", "BCH", "LTC", "DOGE", "ZEC"} {
		coins[coin] = M{"confirmedUnits": int64(0), "pendingUnits": int64(0), "excludedUnits": int64(0)}
	}
	issues := []M{}
	ids := map[string]bool{}
	counts := M{"orders": 0, "heldOrders": 0, "failedAttempts": 0, "supersededOrders": 0, "unresolvedOrders": 0}
	teamRows := []M{}
	for _, o := range orders {
		if s(o["mode"]) != mode {
			continue
		}
		counts["orders"] = n(counts["orders"]) + 1
		if !current(o) {
			counts["supersededOrders"] = n(counts["supersededOrders"]) + 1
			continue
		}
		if held(o) {
			counts["heldOrders"] = n(counts["heldOrders"]) + 1
		} else {
			ids[s(o["id"])] = true
		}
		if !funded(o) {
			counts["failedAttempts"] = n(counts["failedAttempts"]) + 1
		}
		if contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])) {
			counts["unresolvedOrders"] = n(counts["unresolvedOrders"]) + 1
		}
		if len(maps(o["spendHistory"])) > 0 {
			sum := int64(0)
			valid := true
			for _, entry := range maps(o["spendHistory"]) {
				sum += money(entry, "amountBtc")
				valid = valid && integer(entry["amountBtc"]) && !parseTime(entry["at"]).IsZero()
			}
			if !valid || sum != netCost(o) {
				issues = append(issues, M{"orderId": o["id"], "code": "SPEND_HISTORY_TOTAL_MISMATCH", "storedHistoryTotalBtc": sum, "orderNetCostBtc": netCost(o), "effect": "Legacy fallback assigns cost to the original purchase date"})
			}
		}
		if s(o["kind"]) == "team" && len(teamRows) < 500 {
			row := pick(o, []string{"id", "externalId", "packageId", "status", "shares", "costBtc", "feeBtc", "refundBtc", "createdAt"})
			row["personalAllocation"] = pick(obj(o["rewardEstimate"]), []string{"scope", "source", "memberAmount", "totalAmount", "memberShares", "totalShares", "fraction"})
			teamRows = append(teamRows, row)
		}
	}
	for _, r := range rewards {
		if !ids[s(r["orderId"])] || s(r["supersededBy"]) != "" {
			continue
		}
		coin := s(r["coin"])
		if coins[coin] == nil {
			coins[coin] = M{}
		}
		key := "pendingUnits"
		if b(r["confirmed"]) {
			key = "confirmedUnits"
		}
		if !rewardAccounted(r) {
			key = "excludedUnits"
		}
		obj(coins[coin])[key] = n(obj(coins[coin])[key]) + n(r["amount"])
		if market == "BTC" && rewardAccounted(r) && s(r["coin"]) == "BTC" && integer(r["valueBtc"]) && n(r["valueBtc"]) != n(r["amount"]) {
			issues = append(issues, M{"rewardId": r["id"], "code": "BTC_QUANTITY_VALUE_DIFFER", "amountUnits": r["amount"], "valueBtc": r["valueBtc"]})
		}
	}
	for _, value := range coins {
		row := obj(value)
		for _, key := range []string{"confirmedUnits", "pendingUnits", "excludedUnits"} {
			row[key+"Decimal"] = decimal(n(row[key]))
		}
	}
	report := dailyReport(orders, rewards, mode, s(settings["timezone"]), 0, time.Now(), obj(obj(state["runtime"])["exchangeRates"]), market)
	daily := obj(report["total"])
	if n(daily["spend"]) != n(summary["spend"]) || n(daily["earned"]) != n(summary["earned"]) {
		issues = append(issues, M{"code": "DAILY_LIFETIME_TOTAL_DIFFER", "undatedEntries": report["undated"], "possibleCause": "Invalid or future event timestamps are excluded from daily reports"})
	}
	sort.Slice(teamRows, func(i, j int) bool { return s(teamRows[i]["createdAt"]) > s(teamRows[j]["createdAt"]) })
	result := M{"market": market, "mode": mode, "timezone": settings["timezone"], "counts": counts, "btcTotalsSatoshis": summary, "coinQuantities": coins, "dailyAllTimeTotals": daily, "dailyUndatedEntries": report["undated"], "issues": issues, "teams": teamRows, "teamLimit": 500, "teamLimitReached": len(teamRows) == 500, "units": "Integer 1e-8 units in the declared payment currency; coin quantities retain their own currency.", "scope": fmt.Sprintf("Saved %s ledger only; does not establish that provider history is complete", mode)}
	if market == "USDT" {
		result["usdtTotalsUnits"] = result["btcTotalsSatoshis"]
		delete(result, "btcTotalsSatoshis")
		for _, row := range teamRows {
			fundingRecord(market, row)
		}
		for _, row := range issues {
			for key, value := range row {
				if strings.HasSuffix(key, "Btc") {
					row[strings.TrimSuffix(key, "Btc")+"Amount"] = value
					delete(row, key)
				}
			}
		}
	}
	return result
}

func optionalPositiveRate(v any) any {
	var result any
	attempt(func() {
		r := rational(v, "BTC rate")
		f, _ := r.Float64()
		if f > 0 && f < 1e15 {
			result = f
		}
	})
	return result
}
