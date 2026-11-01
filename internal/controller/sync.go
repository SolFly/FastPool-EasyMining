package controller

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
)

func (e *Engine) pendingSync(o M, reason string, metadata M) {
	if o == nil || o["accountingOverride"] != nil || !current(o) {
		return
	}
	previous := obj(o["syncPending"])
	o["syncPending"] = merge(M{"since": first(previous["since"], stamp()), "checkedAt": stamp(), "attempts": n(previous["attempts"]) + 1, "reason": reason, "blocking": true}, metadata)
	e.Store.Save("orders", o)
}
func (e *Engine) holdAttribution(raw M, reason, teamID string, create bool) M {
	o := findBy(e.Store.List("orders"), "externalId", raw["id"])
	if o != nil && s(o["kind"]) == "team" {
		return o
	}
	if o == nil && !create {
		return nil
	}
	if o == nil {
		var cost int64
		if attempt(func() { cost = units(raw["amount"], "unattributed order amount") }) != nil {
			return nil
		}
		o = M{"id": uuid(), "externalId": raw["id"], "mode": "live", "kind": "solo", "name": strfirst(raw["soloMiningCoin"], "Unattributed") + " imported", "coin": strfirst(raw["soloMiningCoin"], "?"), "source": "NiceHash import", "status": normalizeStatus(raw["status"]), "costBtc": cost, "feeBtc": 0, "refundBtc": 0, "shares": 1, "createdAt": first(raw["createdTs"], raw["startTs"], stamp())}
		o = fundingRecord(paymentMarket(raw), o)
	}
	o["attribution"] = M{"state": "review", "version": 1, "at": first(obj(o["attribution"])["at"], stamp()), "reason": reason, "teamId": teamID}
	e.Store.Save("orders", o)
	return o
}
func (e *Engine) repairRejected() {
	for _, o := range e.Store.List("orders") {
		if s(o["kind"]) != "team" || !contains([]string{"FAILED", "REJECTED"}, s(o["status"])) || s(o["externalId"]) == "" || s(o["externalId"]) != s(o["packageId"]) || o["accountingOverride"] != nil {
			continue
		}
		failure := obj(o["submissionFailure"])
		if !b(failure["rejected"]) {
			continue
		}
		rewarded := false
		for _, r := range e.Store.List("rewards") {
			if s(r["orderId"]) == s(o["id"]) {
				rewarded = true
			}
		}
		if rewarded {
			continue
		}
		o["attemptedTeamId"] = o["externalId"]
		o["externalId"] = nil
		setMoney(o, "requestedCostBtc", moneyValue(o, "costBtc"))
		setMoney(o, "feeBtc", 0)
		delete(o, "syncPending")
		e.Store.Save("orders", o)
	}
}
func (e *Engine) sync(ctx context.Context) M {
	defer func() {
		if caught := recover(); caught != nil {
			if _, local := caught.(Problem); local {
				e.RecordError(caught)
			}
			panic(caught)
		}
	}()
	e.repairRejected()
	e.repairAcceptedWaits()
	api := e.Client()
	api.HistoryReadFallbacks = []M{}
	check(s(api.Credentials["key"]) != "", "Connect a NiceHash API key first")
	org := s(api.Credentials["orgId"])
	ledger := s(e.Store.Get("ledgerOrgId"))
	if ledger != "" && !strings.EqualFold(ledger, org) {
		for _, o := range e.Store.List("orders") {
			check(s(o["mode"]) != "live", "This ledger belongs to another organization. Use a separate instance.")
		}
	}
	started := stamp()
	e.runtime(M{"lastSyncAttempt": started, "syncStartedAt": started, "syncStage": "clock", "syncStageAt": started, "syncStatus": "syncing", "buyingReady": false, "historyReadFallbacks": []M{}})
	api.Clock(ctx)
	e.syncStage("balances")
	balances := obj(api.Get(ctx, "/main/api/v2/accounting/accounts2", url.Values{"extendedResponse": {"true"}, "fiat": {"USD"}}, true))
	_, ok := balances["currencies"].([]any)
	check(ok, "Unexpected NiceHash balance response")
	var btc M
	wallets := M{}
	rates := M{"BTC": 1}
	for _, c := range maps(balances["currencies"]) {
		if supportedMarket(s(c["currency"])) {
			wallets[s(c["currency"])] = units(c["available"], s(c["currency"])+" available balance")
		}
		if contains([]string{"BTC", "TBTC"}, s(c["currency"])) {
			btc = c
		}
		if f(c["btcRate"]) > 0 {
			rates[s(c["currency"])] = f(c["btcRate"])
		}
	}
	check(btc != nil, "BTC balance is missing from account response")
	balance := units(btc["available"], "BTC available balance")
	e.Store.Set("verified", true)
	e.runtime(M{"balance": balance, "balances": wallets, "rates": rates, "lastBalanceSync": stamp(), "historyComplete": false})
	e.syncStage("solo-history")
	account := api.Pages(ctx, api.TicketListPath(false), nil, true)
	warnings := []M{}
	warn := func(stage, id string, caught any, tracked M, extra ...M) {
		if a, ok := caught.(*APIError); ok && (a.HTTPStatus == 401 || a.HTTPStatus == 403) {
			panic(a)
		}
		reason := panicError(caught).Error()
		w := M{"stage": stage, "reason": reason, "blocking": true, "checkedAt": stamp()}
		w = merge(w, databaseFailure(caught))
		if len(extra) > 0 {
			w = merge(w, extra[0])
		}
		if api, ok := caught.(*APIError); ok {
			w = merge(w, pick(api.Details(), []string{"httpStatus", "code", "method", "path", "requestId"}))
		}
		if strings.HasPrefix(stage, "team") {
			w["teamId"] = id
		} else {
			w["orderId"] = id
		}
		e.pendingSync(tracked, reason, w)
		if w["blocking"] == false && orderSyncBlocksBuying(tracked) {
			w["blocking"] = true
			e.pendingSync(tracked, reason, w)
		}
		warnings = append(warnings, w)
	}
	teams := []M{}
	e.syncStage("team-history")
	if caught := attempt(func() {
		teams = api.Pages(ctx, api.TicketListPath(true), url.Values{"onlyGold": {"false"}}, true)
	}); caught != nil {
		warn("team-history", "", caught, nil)
	}
	e.Store.Set("ledgerOrgId", org)
	candidates := map[string]M{}
	candidateIDs := []string{}
	shared := map[string]bool{}
	ignored := map[string]bool{}
	knownTeams := []M{}
	for _, o := range e.Store.List("orders") {
		if current(o) && funded(o) && s(o["mode"]) == "live" && s(o["kind"]) == "team" && s(o["externalId"]) != "" {
			knownTeams = append(knownTeams, o)
			shared[s(o["externalId"])] = true
			for _, id := range arr(o["providerOrderIds"]) {
				shared[s(id)] = true
			}
		}
	}
	add := func(id string, extra M) {
		if id == "" {
			return
		}
		c := candidates[id]
		if c == nil {
			c = M{"id": id, "tracked": findBy(knownTeams, "externalId", id), "accountIds": []any{}}
			candidateIDs = append(candidateIDs, id)
		}
		ids := arr(c["accountIds"])
		ids = addUnique(ids, arr(extra["accountIds"])...)
		c = merge(c, extra)
		c["accountIds"] = ids
		candidates[id] = c
	}
	for _, raw := range account {
		if !supportedMarket(paymentMarket(raw)) {
			ignored[strfirst(raw["sharedTicketId"], raw["id"])] = true
			continue
		}
		caught := attempt(func() {
			ref := teamReference(raw)
			if ref == nil {
				for _, known := range knownTeams {
					if s(known["externalId"]) == s(raw["id"]) || includes(arr(known["providerOrderIds"]), raw["id"]) {
						ref = M{"teamId": known["externalId"], "explicit": true}
						break
					}
				}
			}
			if ref == nil {
				return
			}
			shared[s(raw["id"])] = true
			check(s(ref["teamId"]) != "", "Shared reward has no linked team ID; attribution requires review")
			add(s(ref["teamId"]), M{"accountIds": []any{raw["id"]}, "purchasedAt": first(raw["createdTs"], raw["startTs"]), "embedded": ref["embedded"], "accountRaw": raw, "rewardReference": ref["rewardReference"]})
		})
		if caught != nil {
			shared[s(raw["id"])] = true
			e.holdAttribution(raw, panicError(caught).Error(), "", true)
			warn("team-index", s(raw["id"]), caught, findBy(e.Store.List("orders"), "externalId", raw["id"]))
		}
	}
	skipped := 0
	for _, raw := range teams {
		_, state := membership(raw, org)
		tracked := findBy(knownTeams, "externalId", raw["id"])
		if tracked == nil && candidates[s(raw["id"])] == nil && contains([]string{"unjoined", "unrelated"}, state) {
			skipped++
			continue
		}
		market := paymentMarket(raw)
		if tracked == nil && !supportedMarket(market) {
			ignored[s(raw["id"])] = true
			continue
		}
		add(s(raw["id"]), M{"listing": raw})
	}
	for _, known := range knownTeams {
		needs := pending(known) || known["syncPending"] != nil
		for _, r := range e.Store.List("rewards") {
			if s(r["orderId"]) == s(known["id"]) && !b(r["confirmed"]) && s(r["supersededBy"]) == "" {
				needs = true
			}
		}
		if needs {
			add(s(known["externalId"]), M{})
		}
	}
	importedTeams, importedSolo := 0, 0
	e.syncStage("team-details")
	for _, id := range candidateIDs {
		c := candidates[id]
		var detail M
		caught := attempt(func() {
			embedded := obj(c["embedded"])
			if member, _ := membership(embedded, org); member != nil {
				raw := obj(c["accountRaw"])
				check(s(obj(embedded["orderDetails"])["id"]) == "" || s(raw["id"]) == s(embedded["id"]) || s(obj(embedded["orderDetails"])["id"]) == s(raw["id"]), "Embedded team points to a different execution")
				execution := clone(raw)
				delete(execution, "sharedTicket")
				detail = merge(embedded, M{"orderDetails": merge(execution, obj(embedded["orderDetails"]))})
			} else {
				detail = api.Ticket(ctx, id, true)
			}
			check(strings.EqualFold(s(detail["id"]), id), "Team detail returned a different provider ID")
			if b(c["rewardReference"]) {
				check(s(obj(detail["orderDetails"])["id"]) == s(obj(c["accountRaw"])["id"]), "Reward reference did not verify the team execution")
			}
			market := paymentMarket(detail)
			check(supportedMarket(market), "Unsupported team payment currency")
			if tracked := obj(c["tracked"]); len(tracked) > 0 {
				check(paymentMarket(tracked) == market, "Tracked team returned a different payment currency")
			}
			imported := e.importTeam(detail, rates, c)
			if imported == nil && e.acceptedDespiteMissingDetail(obj(c["tracked"]), obj(c["listing"])) && e.acceptedDespiteMissingDetail(obj(c["tracked"]), detail) {
				warn("team-membership", id, Problem{400, "Purchase accepted; NiceHash has not returned this organization’s membership details. Other teams may continue; this team cannot receive another addition yet.", ""}, obj(c["tracked"]), M{"blocking": false, "proof": "accepted-purchase"})
				return
			}
			check(imported != nil, "Waiting for NiceHash to identify this organization’s participation; account sync will retry")
			importedTeams++
			shared[s(imported["externalId"])] = true
			for _, linked := range arr(imported["providerOrderIds"]) {
				shared[s(linked)] = true
			}
			if imported["syncPending"] != nil || s(imported["status"]) == "UNKNOWN" {
				warn("team-confirmation", id, Problem{400, strfirst(obj(imported["syncPending"])["reason"], imported["error"], "Team confirmation is pending"), ""}, imported, pick(obj(imported["syncPending"]), []string{"blocking", "proof", "verifiedAt"}))
			}
		})
		if caught != nil {
			// A signed private index can still verify the personal commitment when
			// the individual detail endpoint is temporarily unavailable. Reward
			// rows stay untouched until a full detail read succeeds.
			if retryableDetailRead(caught) {
				var verified M
				fallback := attempt(func() {
					listing := obj(c["listing"])
					check(strings.EqualFold(s(listing["id"]), id), "No matching private team snapshot")
					verified = e.importTeam(listing, rates, merge(c, M{"fundingOnly": true}))
					check(verified != nil && !held(verified) && s(verified["status"]) != "UNKNOWN" && verified["pendingTeamPurchase"] == nil && verified["fundingVerified"] != nil, "Private listing has not verified the commitment")
				})
				if fallback == nil {
					warn("team-detail", id, caught, verified, M{"blocking": false, "proof": "private-team-member", "verifiedAt": obj(verified["fundingVerified"])["at"]})
					continue
				}
				if databaseFailure(fallback) != nil {
					warn("team-storage", id, fallback, obj(c["tracked"]))
					continue
				}
				// An acknowledged POST keeps its full reservation and purchase count.
				// It never authorizes an addition to the same unverified team.
				tracked := findBy(e.Store.List("orders"), "externalId", id)
				if e.acceptedDespiteMissingDetail(tracked, obj(c["listing"])) {
					warn("team-detail", id, caught, tracked, M{"blocking": false, "proof": "accepted-purchase"})
					continue
				}
			}
			if raw := obj(c["accountRaw"]); len(raw) > 0 && len(obj(c["tracked"])) == 0 {
				e.holdAttribution(raw, panicError(caught).Error(), id, true)
			}
			warn("team-detail", id, caught, obj(c["tracked"]))
		}
	}
	e.auditReads = 0
	e.syncStage("order-rewards")
	seen := map[string]bool{}
	for _, raw := range account {
		seen[s(raw["id"])] = true
		if shared[s(raw["id"])] || !supportedMarket(paymentMarket(raw)) {
			continue
		}
		if caught := attempt(func() {
			o := e.importSolo(ctx, raw, rates)
			if s(o["kind"]) == "team" {
				importedTeams++
				if o["syncPending"] != nil || s(o["status"]) == "UNKNOWN" {
					warn("team-confirmation", s(o["externalId"]), Problem{400, strfirst(obj(o["syncPending"])["reason"], o["error"], "Team confirmation is pending"), ""}, o, pick(obj(o["syncPending"]), []string{"blocking", "proof", "verifiedAt"}))
				}
			} else {
				importedSolo++
			}
		}); caught != nil {
			warn("solo-detail", s(raw["id"]), caught, findBy(e.Store.List("orders"), "externalId", raw["id"]))
		}
	}
	for _, o := range e.Store.List("orders") {
		if current(o) && s(o["mode"]) == "live" && s(o["kind"]) == "solo" && s(o["externalId"]) != "" && !seen[s(o["externalId"])] && (pending(o) || held(o) || o["syncPending"] != nil) {
			if caught := attempt(func() {
				if held(o) {
					check(e.auditReads < 25, "Ownership audit continues in the next account sync")
					e.auditReads++
				}
				e.importSolo(ctx, api.Ticket(ctx, s(o["externalId"]), false), rates)
			}); caught != nil {
				warn("solo-detail", s(o["externalId"]), caught, o)
			}
		}
	}
	for _, o := range e.Store.List("orders") {
		if current(o) && s(o["mode"]) == "live" && held(o) {
			found := false
			for _, w := range warnings {
				if s(w["orderId"]) == s(o["externalId"]) {
					found = true
				}
			}
			if !found {
				warnings = append(warnings, M{"stage": "attribution", "orderId": o["externalId"], "reason": obj(o["attribution"])["reason"]})
			}
		}
	}
	complete := len(warnings) == 0
	buyingReady := true
	for _, w := range warnings {
		if w["blocking"] != false {
			buyingReady = false
		}
	}
	for _, o := range e.Store.List("orders") {
		if current(o) && s(o["mode"]) == "live" && (held(o) || orderSyncBlocksBuying(o) || contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"]))) {
			buyingReady = false
		}
	}
	count := len(warnings)
	if len(warnings) > 100 {
		warnings = warnings[:100]
	}
	finished := stamp()
	stage := map[bool]string{true: "ready", false: "waiting"}[complete]
	progress := M{"syncFinishedAt": finished, "syncStage": stage, "syncStageAt": finished, "historyReadFallbacks": api.HistoryReadFallbacks}
	if complete {
		progress["lastHistoryCompleteAt"] = finished
	}
	e.runtime(progress)
	e.runtime(M{"lastSync": stamp(), "balance": balance, "balances": wallets, "rates": rates, "ignoredUsdt": len(ignored), "errors": 0, "lastError": nil, "lastErrorDetails": nil, "historyComplete": complete, "buyingReady": buyingReady, "syncStatus": map[bool]string{true: "ready", false: "waiting"}[complete], "syncWarnings": warnings, "syncWarningCount": count, "importedTeams": importedTeams, "catalogueTeamsSkipped": skipped, "nextSyncAt": time.Now().Add(time.Duration(n(obj(e.Store.Get("settings"))["accountSyncSeconds"])) * time.Second).UTC().Format(time.RFC3339Nano)})
	return M{"balance": balance, "solo": importedSolo, "teams": importedTeams, "teamRowsReturned": len(teams), "catalogueTeamsSkipped": skipped, "ignoredUsdt": len(ignored), "historyComplete": complete, "buyingReady": buyingReady, "warnings": warnings}
}
func (e *Engine) importSolo(ctx context.Context, raw, rates M) M {
	original := clone(raw)
	check(s(raw["id"]) != "" && raw["amount"] != nil, "Ticket schema is missing ID or amount")
	var result M
	caught := attempt(func() {
		if _, ok := raw["soloReward"].([]any); !ok {
			api := e.Client()
			raw["soloReward"] = api.historyGet(ctx, api.TicketRewardsPath(s(raw["id"])), nil)
		}
		_, ok := raw["soloReward"].([]any)
		check(ok, "Unexpected reward response schema")
		ref := teamReference(raw)
		if ref == nil {
			proof := soloProof(raw, s(e.Credentials()["orgId"]))
			previous := findBy(e.Store.List("orders"), "externalId", raw["id"])
			if proof == "" && s(raw["organizationId"]) == "" && s(obj(previous["attribution"])["state"]) == "personal" && strings.EqualFold(s(obj(previous["attribution"])["organizationId"]), s(e.Credentials()["orgId"])) {
				proof = s(obj(previous["attribution"])["proof"])
			}
			if proof == "" {
				check(e.auditReads < 25, "Ownership audit continues in the next account sync")
				e.auditReads++
				detail := e.Client().Ticket(ctx, s(raw["id"]), false)
				check(s(detail["id"]) == s(raw["id"]), "Private order detail returned a different ID")
				raw = merge(raw, detail)
				ref = teamReference(raw)
				proof = soloProof(raw, s(e.Credentials()["orgId"]))
			}
			if ref == nil {
				check(proof != "", "The API has not verified personal ownership. Cost and rewards are excluded while account sync retries.")
				e.Store.Batch(func(tx *Store) { result = e.importSoloData(tx, raw, proof) })
				return
			}
		}
		check(s(ref["teamId"]) != "", "Shared reward has no linked team ID")
		detail := e.Client().Ticket(ctx, s(ref["teamId"]), true)
		check(s(detail["id"]) == s(ref["teamId"]), "Team detail returned a different provider ID")
		if b(ref["rewardReference"]) {
			check(s(obj(detail["orderDetails"])["id"]) == s(raw["id"]), "Reward reference did not verify execution")
		}
		result = e.importTeam(detail, rates, M{"accountIds": []any{raw["id"]}, "purchasedAt": first(raw["createdTs"], raw["startTs"])})
		check(result != nil, "Waiting for linked team membership")
	})
	if caught != nil {
		e.holdAttribution(original, panicError(caught).Error(), "", true)
		panic(caught)
	}
	return result
}
func (e *Engine) importSoloData(st *Store, raw M, proof string) M {
	market := paymentMarket(raw)
	check(supportedMarket(market), "Unsupported solo payment currency")
	check(teamReference(raw) == nil && proof != "", "Solo import requires verified personal ownership")
	o := findBy(st.List("orders"), "externalId", raw["id"])
	if o == nil && s(raw["requestId"]) != "" {
		o = findBy(st.List("orders"), "requestId", raw["requestId"])
	}
	if o != nil && !current(o) {
		return o
	}
	if o != nil {
		check(paymentMarket(o) == market, "Solo execution returned a different payment currency")
	}
	cost := units(raw["amount"], "solo order amount")
	if o == nil {
		o = M{"id": uuid(), "mode": "live", "kind": "solo", "strategyId": nil, "name": s(raw["soloMiningCoin"]) + " imported", "coin": strfirst(raw["soloMiningCoin"], "?"), "createdAt": first(raw["createdTs"], raw["startTs"], stamp()), "packageId": nil, "shares": 1, "refundBtc": 0, "source": "NiceHash import"}
		o = fundingRecord(market, o)
	}
	o = merge(o, M{"externalId": raw["id"], "status": normalizeStatus(raw["status"]), "costBtc": cost, "feeBtc": 0, "endAt": first(raw["endTs"], o["endAt"]), "attribution": M{"state": "personal", "version": 1, "at": stamp(), "organizationId": e.Credentials()["orgId"], "proof": proof}, "payoutAddress": first(raw["soloMiningRewardAddr"], o["payoutAddress"], ""), "mergeCoin": first(raw["soloMiningMergeCoin"], o["mergeCoin"]), "accountingNote": "Order amount reported by NiceHash. Package price is inclusive; ambiguous refunds require reconciliation."})
	o = fundingRecord(market, o)
	delete(o, "syncPending")
	delete(o, "error")
	if contains([]string{"CANCELLED", "ERROR", "ERROR_ON_CREATION", "ERROR_ON_CREATION_ON_REVERTING_TRANSACTIONS"}, status(raw["status"])) {
		o["status"] = "UNKNOWN"
		o["accountingNote"] = "Verify final debit and refund for the cancelled/error order"
	}
	if o["accountingOverride"] != nil {
		o = merge(o, obj(obj(o["accountingOverride"])["values"]))
	}
	st.Save("orders", o)
	for _, r := range maps(raw["soloReward"]) {
		check(r["shared"] != true, "A shared reward cannot be recorded as personal solo")
		check(s(r["id"]) != "" && integer(r["payoutReward"]) && n(r["payoutReward"]) >= 0, "Invalid solo reward ID or quantity")
		previous := findBy(st.List("rewards"), "id", r["id"])
		confirmed := (b(r["depositComplete"]) && !b(r["depositDonated"])) || previous["manualConfirmed"] != nil
		var confirmedAt, value any
		if confirmed {
			confirmedAt = first(previous["confirmedAt"], stamp())
		}
		if b(previous["confirmed"]) {
			value = previous["valueBtc"]
		} else if r["payoutRewardBtc"] != nil {
			value = units(r["payoutRewardBtc"], "solo reward BTC value")
		} else if s(r["coin"]) == "BTC" {
			value = r["payoutReward"]
		}
		created := first(r["createdTs"], stamp())
		if r["createdTs"] == nil && r["time"] != nil {
			created = time.UnixMilli(n(r["time"])).UTC().Format(time.RFC3339Nano)
		}
		row := M{"id": r["id"], "orderId": o["id"], "coin": r["coin"], "amount": n(r["payoutReward"]), "createdAt": created, "confirmed": confirmed, "manualConfirmed": previous["manualConfirmed"], "confirmedAt": confirmedAt, "depositDonated": b(r["depositDonated"]), "confirmations": first(r["confirmations"], 0), "minConfirmations": first(r["minConfirmations"], 0), "valueBtc": value, "scope": "personal-solo", "providerShared": r["shared"], "providerPackageId": r["packageId"], "valuation": "NiceHash reported BTC equivalent; not an executed conversion", "blockHeight": r["blockHeight"], "tx": first(r["tx"], "")}
		row["valueUsdt"] = previous["valueUsdt"]
		row["usdtValuation"] = previous["usdtValuation"]
		row["usdtValuationFrozen"] = previous["usdtValuationFrozen"]
		row["manualUsdtValuation"] = previous["manualUsdtValuation"]
		usdtRewardValue(row, obj(obj(e.Store.Get("runtime"))["rates"]))
		st.Save("rewards", row)
	}
	return o
}
func (e *Engine) importTeam(raw, rates, context M) M {
	market := paymentMarket(raw)
	check(supportedMarket(market), "Unsupported shared payment currency")
	var result M
	e.Store.Batch(func(tx *Store) { result = e.importTeamData(tx, raw, rates, context) })
	return result
}
func (e *Engine) importTeamData(st *Store, raw, rates, context M) M {
	market := paymentMarket(raw)
	if explicit := s(obj(raw["orderDetails"])["currencyMarket"]); explicit != "" {
		check(explicit == market, "Shared execution and team template disagree on payment currency")
	}
	member, _ := membership(raw, s(e.Credentials()["orgId"]))
	if member == nil {
		return nil
	}
	o := findBy(st.List("orders"), "externalId", raw["id"])
	if o != nil {
		check(paymentMarket(o) == market, "Shared execution returned a different payment currency")
	}
	accepted := acceptedTeamCommitment(o)
	if b(context["fundingOnly"]) {
		check(!held(o), "A prior accounting review requires full team details")
		check(o["accountingOverride"] == nil && contains([]string{"OK", "RETURNED"}, s(member["paymentStatus"])), "Private team snapshot has no final personal payment status")
		check(s(member["paymentStatus"]) == "RETURNED" || units(member["addedAmount"], "team member addedAmount") >= money(o, "costBtc"), "Private snapshot would reduce an existing commitment")
	}
	var prior M
	if o != nil && s(o["kind"]) == "team" {
		prior = clone(o)
	}
	if o != nil && s(o["kind"]) == "solo" {
		check(automatic(o), "A manually edited solo record conflicts with this team")
		for _, r := range st.List("rewards") {
			if s(r["orderId"]) == s(o["id"]) {
				check(!editedReward(r), "A manually edited reward conflicts with this team")
				if s(r["teamId"]) == "" {
					r["supersededBy"] = "team:" + s(raw["id"])
					st.Save("rewards", r)
				}
			}
		}
		o["kind"] = "team"
		o["coin"] = first(obj(obj(raw["currencyAlgoTicket"])["currencyAlgo"])["currency"], o["coin"])
	}
	if o == nil {
		o = M{"id": uuid(), "externalId": raw["id"], "mode": "live", "kind": "team", "strategyId": nil, "name": strfirst(obj(raw["currencyAlgoTicket"])["name"], "Imported team"), "coin": strfirst(obj(obj(raw["currencyAlgoTicket"])["currencyAlgo"])["currency"], "?"), "createdAt": first(context["purchasedAt"], raw["createdTs"], stamp()), "feeBtc": 0, "refundBtc": 0, "source": "NiceHash import"}
		o = fundingRecord(market, o)
	}
	o["kind"] = "team"
	o["packageId"] = raw["id"]
	o["attribution"] = M{"state": "team-member", "version": 1, "at": stamp(), "organizationId": e.Credentials()["orgId"], "proof": "matching organization in team membership"}
	o["rewardEstimate"] = teamEstimate(raw, member)
	o["shares"] = first(obj(o["rewardEstimate"])["memberShares"], obj(member["shares"])["small"], o["shares"], 1)
	o["payoutAddress"] = first(member["soloMiningRewardAddr"], o["payoutAddress"], "")
	o["mergePayoutAddress"] = first(member["mergeSoloMiningRewardAddr"], o["mergePayoutAddress"], "")
	o["mergeCoin"] = first(obj(obj(raw["currencyAlgoTicket"])["mergeCurrencyAlgo"])["currency"], o["mergeCoin"])
	cost := units(member["addedAmount"], "team member addedAmount")
	if p := obj(o["pendingTeamPurchase"]); len(p) > 0 {
		if cost < money(p, "targetCostBtc") || s(member["paymentStatus"]) == "RETURNED" {
			check(!b(context["fundingOnly"]), "Private snapshot has not verified the full submitted amount")
			o["status"] = "UNKNOWN"
			o["error"] = "Waiting for NiceHash to verify the full team level commitment"
			o["syncPending"] = M{"since": first(obj(o["syncPending"])["since"], stamp()), "attempts": obj(o["syncPending"])["attempts"], "checkedAt": stamp(), "reason": o["error"], "blocking": true}
			if accepted && s(member["paymentStatus"]) == "OK" {
				o["status"] = "PENDING"
				o["shares"] = p["targetShares"]
				delete(o, "error")
				o["syncPending"] = merge(obj(o["syncPending"]), M{"reason": "Purchase accepted; NiceHash membership has not caught up with the full team commitment", "blocking": false, "proof": "accepted-purchase"})
			}
			st.Save("orders", o)
			return o
		}
		buys := maps(o["teamBuys"])
		for _, entry := range buys {
			if s(entry["requestId"]) == s(p["requestId"]) {
				entry["status"] = "CONFIRMED"
				entry["verifiedAt"] = stamp()
			}
		}
		o["teamBuys"] = buys
		delete(o, "pendingTeamPurchase")
	}
	if contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])) && !automatic(o) && cost < money(o, "costBtc") && s(member["paymentStatus"]) != "RETURNED" {
		o["status"] = "UNKNOWN"
		o["error"] = "Team membership does not confirm the full submitted amount"
		st.Save("orders", o)
		return o
	}
	previousCost := money(o, "costBtc")
	setMoney(o, "costBtc", cost)
	if s(member["paymentStatus"]) == "RETURNED" {
		setMoney(o, "costBtc", max(previousCost, cost))
	}
	setMoney(o, "feeBtc", 0)
	o["status"] = normalizeStatus(raw["status"])
	details := obj(raw["orderDetails"])
	if details["status"] != nil && normalizeStatus(details["status"]) != "UNKNOWN" {
		o["status"] = normalizeStatus(details["status"])
	}
	o["endAt"] = first(details["endTs"], raw["lifeTimeTill"])
	delete(o, "error")
	delete(o, "syncPending")
	delete(o, "rewardPrecisionNote")
	if s(member["paymentStatus"]) == "RETURNED" {
		setMoney(o, "refundBtc", moneyValue(o, "costBtc"))
		o["status"] = "CANCELLED"
	} else if contains([]string{"FAILED", "RETURNED_FAILED"}, s(member["paymentStatus"])) {
		o["status"] = "UNKNOWN"
		o["syncPending"] = M{"since": stamp(), "reason": "Waiting for NiceHash to resolve team payment status " + s(member["paymentStatus"])}
	}
	if b(context["fundingOnly"]) && prior != nil && s(member["paymentStatus"]) != "RETURNED" && contains([]string{"COMPLETED", "CANCELLED"}, s(prior["status"])) && details["status"] == nil {
		o["status"] = prior["status"]
		o["endAt"] = prior["endAt"]
	}
	ids := addUnique(arr(o["providerOrderIds"]), arr(context["accountIds"])...)
	ids = addUnique(ids, details["id"])
	filtered := []any{}
	for _, id := range ids {
		if s(id) != s(raw["id"]) {
			filtered = append(filtered, id)
		}
	}
	o["providerOrderIds"] = filtered
	for _, alias := range st.List("orders") {
		if !current(alias) || s(alias["id"]) == s(o["id"]) || s(alias["mode"]) != "live" || !includes(filtered, alias["externalId"]) {
			continue
		}
		check(s(alias["kind"]) == "solo" && automatic(alias), "A manually edited record conflicts with a verified team execution")
		for _, r := range st.List("rewards") {
			if s(r["orderId"]) == s(alias["id"]) {
				check(!editedReward(r), "A manually edited reward conflicts with a verified team execution")
			}
		}
		alias["supersededBy"] = o["id"]
		alias["status"] = "SUPERSEDED"
		alias["accountingNote"] = "Duplicate shared execution; excluded from financial totals"
		st.Save("orders", alias)
	}
	if o["accountingOverride"] != nil {
		o = merge(o, obj(obj(o["accountingOverride"])["values"]))
	}
	if prior != nil && netCost(prior) != netCost(o) {
		o["spendHistory"] = append(spendEntries(prior), spendEntry(paymentMarket(o), stamp(), netCost(o)-netCost(prior), "Team contribution/refund change first observed by sync"))
	}
	if b(context["fundingOnly"]) {
		check(!held(o) && !contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])) && o["pendingTeamPurchase"] == nil, "Team commitment remains unverified")
		o["fundingVerified"] = M{"at": stamp(), "market": market, "amount": money(o, "costBtc"), "shares": o["shares"], "paymentStatus": member["paymentStatus"], "source": "private-team-member"}
		st.Save("orders", o)
		return o
	}
	rows := maps(member["rewards"])
	if member["rewards"] != nil {
		_, ok := member["rewards"].([]any)
		check(ok, "NiceHash team member rewards must be an array")
	}
	if member["rewards"] == nil && member["rewardAmount"] != nil {
		rows = []M{{"coin": o["coin"], "rewardAmount": member["rewardAmount"], "rewardFeeAmount": first(member["rewardFeeAmount"], 0)}}
	}
	grouped := map[string][]any{}
	fees := map[string][]any{}
	for _, row := range rows {
		coin := strfirst(row["coin"], row["currency"])
		check(coinRE.MatchString(coin), "NiceHash team reward has an invalid coin")
		grouped[coin] = append(grouped[coin], row["rewardAmount"])
		fees[coin] = append(fees[coin], first(row["rewardFeeAmount"], 0))
	}
	for coin, amounts := range grouped {
		amount := sumUnits(amounts, "team "+coin+" personal reward")
		reportedFees := obj(o["reportedRewardFees"])
		reportedFees[coin] = sumUnits(fees[coin], "reported reward fee")
		o["reportedRewardFees"] = reportedFees
		pieces := []M{}
		recorded := int64(0)
		for _, r := range st.List("rewards") {
			if s(r["teamId"]) == s(raw["id"]) && s(r["coin"]) == coin && s(r["supersededBy"]) == "" {
				pieces = append(pieces, r)
				recorded += n(r["amount"])
			}
		}
		if amount < recorded {
			o["status"] = "UNKNOWN"
			o["error"] = "Provider personal reward total decreased; verify payout adjustments"
			o["attribution"] = M{"state": "review", "version": 1, "at": stamp(), "teamId": raw["id"], "reason": o["error"]}
			continue
		}
		if amount > recorded {
			id := fmt.Sprintf("team:%s:%s:%d", s(raw["id"]), coin, amount)
			if findBy(pieces, "id", id) != nil {
				id += fmt.Sprintf(":from:%d", recorded)
			}
			created := any(stamp())
			if len(pieces) == 0 {
				created = first(details["endTs"], stamp())
			}
			pieces = append(pieces, M{"id": id, "orderId": o["id"], "teamId": raw["id"], "coin": coin, "amount": amount - recorded, "createdAt": created, "confirmed": false, "valueBtc": nil})
		}
		providerConfirmed := false
		if b(member["claimed"]) {
			for _, r := range maps(details["soloReward"]) {
				if s(r["coin"]) == coin && b(r["depositComplete"]) && n(r["confirmations"]) != -1 && !b(r["depositDonated"]) {
					providerConfirmed = true
				}
			}
		}
		for _, piece := range pieces {
			piece["scope"] = "team-member"
			if !b(piece["confirmed"]) {
				if coin == "BTC" {
					piece["valueBtc"] = piece["amount"]
				} else if f(rates[coin]) > 0 {
					piece["valueBtc"] = round(float64(n(piece["amount"])) * f(rates[coin]))
				} else {
					piece["valueBtc"] = nil
				}
				piece["confirmed"] = providerConfirmed || piece["manualConfirmed"] != nil
				if b(piece["confirmed"]) {
					piece["confirmedAt"] = stamp()
				}
			}
			if !editedReward(piece) {
				piece["valuation"] = "NiceHash personal net member payout at account BTC rate; reported fees are not deducted again"
			}
			usdtRewardValue(piece, rates)
			st.Save("rewards", piece)
		}
	}
	st.Save("orders", o)
	return o
}
