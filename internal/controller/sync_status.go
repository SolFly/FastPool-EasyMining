package controller

import "strings"

// acceptedTeamCommitment recognizes a successful POST, not merely a saved
// intent. Older releases persisted PENDING only after validating Buy's result;
// UNKNOWN/SUBMITTING entries (including lost responses) are never evidence.
func acceptedTeamCommitment(o M) bool {
	if !funded(o) || held(o) || s(o["mode"]) != "live" || s(o["kind"]) != "team" || o["accountingOverride"] != nil || !contains([]string{"PENDING", "ACTIVE", "COMPLETED"}, s(o["status"])) || money(o, "feeBtc") != 0 {
		return false
	}
	p := obj(o["pendingTeamPurchase"])
	if len(p) > 0 {
		if s(p["requestId"]) == "" || money(p, "targetCostBtc") <= 0 || money(p, "targetCostBtc") != money(o, "costBtc") || n(p["targetShares"]) <= 0 || n(p["targetShares"]) != n(o["shares"]) {
			return false
		}
		for _, entry := range maps(o["teamBuys"]) {
			if s(entry["requestId"]) == s(p["requestId"]) {
				return s(entry["status"]) == "PENDING" && entry["failure"] == nil
			}
		}
		return false
	}
	for _, receipt := range maps(o["purchaseReceipts"]) {
		if s(receipt["requestId"]) != "" && !parseTime(receipt["at"]).IsZero() && n(receipt["totalAmount"]) == money(o, "costBtc") && n(receipt["totalShares"]) == n(o["shares"]) && money(o, "costBtc") > 0 {
			return true
		}
	}
	return false
}

func orderSyncBlocksBuying(o M) bool {
	if !funded(o) || (o["syncPending"] == nil && o["pendingTeamPurchase"] == nil) {
		return false
	}
	p := obj(o["syncPending"])
	if p["blocking"] == false {
		if s(p["proof"]) == "accepted-purchase" && acceptedTeamCommitment(o) {
			return false
		}
		v := obj(o["fundingVerified"])
		if s(p["proof"]) == "private-team-member" && s(p["verifiedAt"]) != "" && s(p["verifiedAt"]) == s(v["at"]) && s(v["market"]) == paymentMarket(o) && n(v["amount"]) == money(o, "costBtc") && o["pendingTeamPurchase"] == nil && !held(o) && !contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])) {
			return false
		}
	}
	return true
}

func (e *Engine) acceptedDespiteMissingDetail(o, listing M) bool {
	if !acceptedTeamCommitment(o) {
		return false
	}
	if len(listing) == 0 {
		return true
	}
	if paymentMarket(listing) != paymentMarket(o) {
		return false
	}
	member, _ := membership(listing, s(e.Credentials()["orgId"]))
	if member != nil {
		if !contains([]string{"", "OK"}, s(member["paymentStatus"])) || attempt(func() { units(member["addedAmount"], "team member contribution") }) != nil {
			return false
		}
	}
	return true
}

func syncPrivateValues(state M) []string {
	private := []string{}
	private = append(private, s(obj(state["connection"])["organizationId"]))
	for _, table := range []string{"orders", "strategies"} {
		for _, o := range maps(state[table]) {
			private = append(private, s(o["payoutAddress"]), s(o["mergePayoutAddress"]))
		}
	}
	return private
}

func syncDiagnostics(state M) M {
	rt := obj(state["runtime"])
	private := syncPrivateValues(state)
	out := pick(rt, []string{"lastSync", "lastBalanceSync", "lastTick", "lastSyncAttempt", "nextSyncAt", "historyComplete", "buyingReady", "syncStatus", "syncWarningCount", "syncStage", "syncStageAt", "syncStartedAt", "syncFinishedAt", "lastHistoryCompleteAt"})
	clean := func(v M) M {
		r := pick(v, []string{"stage", "source", "dbCode", "dbExtendedCode", "orderId", "teamId", "blocking", "httpStatus", "code", "method", "path", "fromPath", "toPath", "requestId", "providerErrorId", "checkedAt"})
		for _, key := range []string{"stage", "source", "orderId", "teamId", "code", "method", "path", "fromPath", "toPath", "requestId", "providerErrorId", "checkedAt"} {
			if r[key] != nil {
				r[key] = sanitize(s(r[key]), nil, private...)
			}
		}
		if v["reason"] != nil {
			r["reason"] = sanitize(s(v["reason"]), nil, private...)
		}
		return r
	}
	warnings := []M{}
	for _, w := range maps(rt["syncWarnings"]) {
		warnings = append(warnings, clean(w))
		if len(warnings) == 100 {
			break
		}
	}
	out["syncWarnings"] = warnings
	fallbacks := []M{}
	for _, row := range maps(rt["historyReadFallbacks"]) {
		fallbacks = append(fallbacks, clean(row))
		if len(fallbacks) == 20 {
			break
		}
	}
	out["historyReadFallbacks"] = fallbacks
	if rt["lastError"] != nil {
		out["lastError"] = sanitize(s(rt["lastError"]), nil, private...)
	}
	if rt["lastErrorDetails"] != nil {
		out["lastErrorDetails"] = clean(obj(rt["lastErrorDetails"]))
	}
	return out
}

func syncIssues(state M) []M {
	issues := []M{}
	private := syncPrivateValues(state)
	for _, o := range maps(state["orders"]) {
		if !current(o) || s(o["mode"]) != "live" || (o["syncPending"] == nil && o["pendingTeamPurchase"] == nil && !held(o) && !contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"]))) {
			continue
		}
		p := obj(o["syncPending"])
		i := merge(pick(o, []string{"id", "strategyId", "externalId", "packageId", "requestId", "kind", "status"}), pick(p, []string{"since", "checkedAt", "attempts", "stage", "source", "dbCode", "dbExtendedCode", "httpStatus", "code", "method", "path", "proof", "verifiedAt"}), M{
			"market": paymentMarket(o), "name": sanitize(s(o["name"]), nil, private...), "since": first(p["since"], o["createdAt"]),
			"reason":   sanitize(strfirst(p["reason"], obj(o["attribution"])["reason"], o["error"], "Purchase response is unverified"), nil, private...),
			"blocking": held(o) || contains([]string{"UNKNOWN", "SUBMITTING"}, s(o["status"])) || orderSyncBlocksBuying(o), "reservedAmount": netCost(o),
		})
		if s(p["requestId"]) != "" {
			i["syncRequestId"] = p["requestId"]
		}
		if pending := obj(o["pendingTeamPurchase"]); len(pending) > 0 {
			i = merge(i, M{"pendingRequestId": pending["requestId"], "targetAmount": money(pending, "targetCostBtc"), "targetShares": pending["targetShares"]})
		}
		issues = append(issues, i)
	}
	return issues
}

func buyingHistoryReady(rt M) bool { return b(rt["historyComplete"]) || b(rt["buyingReady"]) }

func armingHistoryError(rt M) string {
	for _, warning := range maps(rt["syncWarnings"]) {
		if warning["blocking"] == false || s(warning["reason"]) == "" {
			continue
		}
		reason := strings.TrimRight(s(warning["reason"]), " .")
		if s(warning["source"]) == "database" || reason == "database is locked" {
			return "Cannot arm live buying: the local database could not save synchronized history (" + reason + "). Retry account sync; arming stays blocked until the save succeeds."
		}
		return "Cannot arm live buying: " + reason + ". Review the history warning and retry account sync."
	}
	return "Balance verified; history is still incomplete. Account sync will retry automatically; review sync warnings."
}

func (e *Engine) repairAcceptedWaits() {
	for _, o := range e.Store.List("orders") {
		// Prior releases changed an acknowledged level to UNKNOWN merely because
		// membership was behind the successful POST. Repair only that exact case.
		if s(o["status"]) != "UNKNOWN" || s(o["error"]) != "Waiting for NiceHash to verify the full team level commitment" {
			continue
		}
		candidate := merge(o, M{"status": "PENDING"})
		candidate["shares"] = obj(o["pendingTeamPurchase"])["targetShares"]
		if !acceptedTeamCommitment(candidate) {
			continue
		}
		o["status"] = "PENDING"
		o["shares"] = candidate["shares"]
		delete(o, "error")
		e.pendingSync(o, "Purchase accepted; waiting for team membership details before adding more shares to this team", M{"stage": "team-confirmation", "blocking": false, "proof": "accepted-purchase"})
	}
}

func retryableDetailRead(caught any) bool {
	api, ok := caught.(*APIError)
	return ok && api.Method == "GET" && (api.HTTPStatus == 0 || api.HTTPStatus == 404 || api.HTTPStatus == 410 || api.HTTPStatus == 429 || api.HTTPStatus >= 500)
}
