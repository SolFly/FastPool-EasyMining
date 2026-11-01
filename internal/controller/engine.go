package controller

import (
	"context"
	"crypto/rand"
	"math/big"
	"regexp"
	"sync"
	"time"
)

type Engine struct {
	Store       *Store
	Credentials func() M
	mu          sync.Mutex
	api         *NiceHash
	auditReads  int
	APIOverride func(M) *NiceHash
}

func (e *Engine) Client() *NiceHash {
	c := e.Credentials()
	profile := purchaseProfile(obj(e.Store.Get("settings")))
	if e.api == nil || string(encode(e.api.Credentials)) != string(encode(c)) || e.api.PurchaseProfile != profile {
		if e.APIOverride != nil {
			e.api = e.APIOverride(c)
		} else {
			e.api = NewNiceHash(c)
		}
		e.api.PurchaseProfile = profile
	}
	return e.api
}
func (e *Engine) runtime(patch M)        { e.Store.Set("runtime", merge(obj(e.Store.Get("runtime")), patch)) }
func (e *Engine) syncStage(stage string) { e.runtime(M{"syncStage": stage, "syncStageAt": stamp()}) }
func (e *Engine) Busy() bool {
	if e.mu.TryLock() {
		e.mu.Unlock()
		return false
	}
	return true
}
func (e *Engine) exclusive(fn func(string) any) any {
	if !e.mu.TryLock() {
		conflict("A purchase or sync is in progress. Wait for it to finish.")
	}
	defer e.mu.Unlock()
	owner := uuid()
	check(e.Store.Acquire(owner), "Another process owns the purchase lock; wait for it to finish")
	defer e.Store.Release(owner)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				e.Store.Renew(owner)
			case <-stop:
				return
			}
		}
	}()
	defer func() { close(stop); <-done }()
	defer func() {
		if caught := recover(); caught != nil {
			if _, local := caught.(Problem); !local {
				e.RecordError(caught)
			}
			panic(caught)
		}
	}()
	return fn(owner)
}
func (e *Engine) Pause(reason string) {
	settings := obj(e.Store.Get("settings"))
	settings["running"] = false
	settings["liveArmed"] = false
	e.Store.Set("settings", settings)
	e.Store.Event("warning", "Engine paused: "+reason)
}
func (e *Engine) RecordError(caught any) {
	err := panicError(caught)
	rt := obj(e.Store.Get("runtime"))
	if api, ok := caught.(*APIError); ok && api.TeamStateRejected() {
		rt["lastPurchaseRejection"] = api.Details()
		rt["lastTick"] = stamp()
		e.Store.Set("runtime", rt)
		e.Store.Event("warning", "Team purchase skipped (NiceHash code 5251): "+api.Path+" · team state does not allow buying; waiting for a different matching team")
		return
	}
	rt["errors"] = n(rt["errors"]) + 1
	rt["lastError"] = err.Error()
	rt["lastTick"] = stamp()
	rt["lastErrorDetails"] = nil
	if storage := databaseFailure(caught); storage != nil {
		rt["lastErrorDetails"] = storage
	}
	e.Store.Event("error", err.Error())
	if api, ok := caught.(*APIError); ok {
		rt["lastErrorDetails"] = api.Details()
		if api.Method == "GET" && e.api != nil {
			rt["historyReadFallbacks"] = e.api.HistoryReadFallbacks
		}
		if api.HTTPStatus == 401 || api.HTTPStatus == 403 {
			e.Store.Set("verified", false)
			rt["syncStatus"] = "authentication-error"
			rt["historyComplete"] = false
			rt["buyingReady"] = false
			rt["syncStage"] = "authentication-error"
			rt["syncFinishedAt"] = stamp()
			e.Store.Set("runtime", rt)
			e.Pause("NiceHash rejected authentication or permissions")
			return
		}
		if api.Rejected() {
			rt["lastPurchaseRejection"] = api.Details()
			e.Store.Set("runtime", rt)
			return
		}
	}
	rt["syncStatus"] = "retrying"
	rt["historyComplete"] = false
	rt["buyingReady"] = false
	rt["syncStage"] = "retrying"
	rt["syncFinishedAt"] = stamp()
	rt["nextSyncAt"] = time.Now().Add(time.Duration(n(obj(e.Store.Get("settings"))["accountSyncSeconds"])) * time.Second).UTC().Format(time.RFC3339Nano)
	e.Store.Set("runtime", rt)
}
func (e *Engine) RefreshRates(ctx context.Context, force bool) any {
	previous := obj(obj(e.Store.Get("runtime"))["exchangeRates"])
	if !force && !parseTime(previous["at"]).IsZero() && time.Since(parseTime(previous["at"])) < 5*time.Minute {
		return previous
	}
	var rates any
	caught := attempt(func() {
		rates = normalizeRates(obj(e.Client().Get(ctx, "/main/api/v2/exchangeRate/list", nil, false)))
		e.runtime(M{"exchangeRates": rates, "ratesError": nil})
	})
	if caught != nil {
		e.runtime(M{"ratesError": panicError(caught).Error()})
		return previous
	}
	return rates
}
func (e *Engine) RefreshPackages(ctx context.Context) []M {
	packages := e.Client().Packages(ctx)
	if s(obj(e.Store.Get("settings"))["mode"]) == "live" {
		orders := e.Store.List("orders")
		for _, p := range packages {
			if b(p["team"]) && rejectedTarget(orders, s(p["id"]), purchaseProfile(obj(e.Store.Get("settings")))) {
				p["available"] = false
				p["availabilityReason"] = rejectedTargetReason(orders, s(p["id"]), purchaseProfile(obj(e.Store.Get("settings"))))
			}
		}
	}
	e.Store.Set("packages", packages)
	e.RefreshRates(ctx, false)
	if s(obj(e.Store.Get("settings"))["mode"]) == "paper" {
		e.runtime(M{"errors": 0})
	}
	return packages
}
func (e *Engine) SyncNow(ctx context.Context) any {
	return e.exclusive(func(string) any { result := e.sync(ctx); e.RefreshPackages(ctx); return result })
}
func (e *Engine) Background(ctx context.Context) {
	if e.Busy() {
		return
	}
	settings := obj(e.Store.Get("settings"))
	rt := obj(e.Store.Get("runtime"))
	due := func(v any, seconds int64) bool {
		return parseTime(v).IsZero() || time.Since(parseTime(v)) >= time.Duration(seconds)*time.Second
	}
	if b(settings["running"]) && due(rt["lastTick"], n(settings["pollSeconds"])) {
		e.Tick(ctx, false)
		return
	}
	if settings["autoSync"] != false && s(e.Credentials()["key"]) != "" && due(first(rt["lastSyncAttempt"], rt["lastSync"]), n(settings["accountSyncSeconds"])) {
		e.SyncNow(ctx)
		return
	}
	if due(rt["lastCatalogueAttempt"], 60) {
		e.exclusive(func(string) any { e.runtime(M{"lastCatalogueAttempt": stamp()}); return e.RefreshPackages(ctx) })
	}
}
func (e *Engine) Tick(ctx context.Context, manual bool) any {
	return e.exclusive(func(owner string) any {
		var finish func()
		ctx, finish = e.beginPurchaseDebug(ctx, "strategy evaluation")
		defer finish()
		settings := obj(e.Store.Get("settings"))
		if !b(settings["running"]) && !manual {
			return M{"paused": true}
		}
		if s(settings["mode"]) == "live" {
			e.sync(ctx)
			e.RefreshPackages(ctx)
		} else {
			e.RefreshPackages(ctx)
			e.settlePaper()
		}
		if trace := debugTrace(ctx); trace != nil {
			trace.network = true
		}
		debugStep(ctx, "catalogue_ready", M{"packageCount": len(maps(e.Store.Get("packages"))), "historyComplete": obj(e.Store.Get("runtime"))["historyComplete"]})
		decisions := []M{}
		for _, st := range e.Store.List("strategies") {
			if s(obj(e.Store.Get("settings"))["mode"]) != s(settings["mode"]) || !e.Store.Owns(owner) {
				break
			}
			state := e.Store.State()
			orders := []M{}
			for _, o := range maps(state["orders"]) {
				if s(o["mode"]) == s(settings["mode"]) {
					orders = append(orders, o)
				}
			}
			q := pickQuote(maps(state["packages"]), st, orders, purchaseProfile(settings))
			reason := guard(state, st, q, time.Now(), false)
			debugDecision(ctx, st, q, reason)
			decision := M{"id": st["id"], "name": st["name"], "reason": strfirst(reason, "Ready to buy"), "quote": q}
			decisions = append(decisions, decision)
			if reason != "" {
				continue
			}
			order := e.execute(ctx, st, q, owner, "", nil, nil)
			debugPurchaseResult(ctx, order)
			decision["reason"] = "Purchase " + s(order["status"])
			failure := obj(order["lastTeamPurchaseFailure"])
			if len(failure) == 0 {
				failure = obj(order["submissionFailure"])
			}
			if teamStateRejectedFailure(failure) {
				decision["reason"] = teamStateRejectedReason
				continue
			}
			if s(order["status"]) == "FAILED" || s(order["status"]) == "UNKNOWN" {
				decision["reason"] = order["error"]
				break
			}
		}
		e.runtime(M{"lastTick": stamp(), "decisions": decisions})
		return M{"decisions": decisions}
	})
}
func teamSnapshot(q M) M {
	if q == nil {
		return nil
	}
	return fundingRecord(paymentMarket(q), M{"id": q["id"], "name": q["name"], "coin": q["coin"], "mergeCoin": q["mergeCoin"], "market": q["market"], "status": q["status"], "state": q["teamState"], "available": q["available"], "quotedAt": q["quotedAt"], "buyUntil": q["buyUntil"], "sharePriceBtc": first(q["minShare"], q["price"]), "joinedShares": q["teamShares"]})
}
func (e *Engine) purchaseCheck(q, st M, manual bool) M {
	selection := "strategy"
	if manual {
		selection = "manual"
	} else if q["teamLevel"] != nil {
		selection = "levels"
	}
	return fundingRecord(paymentMarket(q), M{"checkedAt": stamp(), "clockOffsetMs": e.Client().Offset, "selection": selection, "fixedTeam": s(st["packageId"]) != "", "shares": first(q["shares"], st["shares"]), "additionalCostBtc": moneyValue(q, "costBtc"), "level": q["teamLevel"], "before": teamSnapshot(q)})
}
func (e *Engine) prepareAddition(ctx context.Context, q, st, before M) (M, M) {
	raw := e.Client().PurchaseTeamDetails(ctx, s(q["id"]))
	pkg := normalizePackage(raw, stamp(), true)
	member, ownership := membership(raw, s(e.Credentials()["orgId"]))
	check(s(raw["id"]) == s(q["id"]) && b(pkg["available"]) && (s(raw["state"]) == "" || contains([]string{"OPEN", "PENDING"}, s(raw["state"]))) && paymentMarket(pkg) == paymentMarket(q) && s(pkg["coin"]) == s(q["coin"]) && s(pkg["mergeCoin"]) == s(q["mergeCoin"]) && money(pkg, "costBtc")*n(st["shares"]) == money(q, "costBtc") && n(pkg["teamShares"]) >= n(obj(q["teamLevel"])["threshold"]), "Team or level price changed; wait for a new evaluation")
	check(ownership != "unattributed" && member != nil, "Team membership cannot be verified before adding shares")
	cost := units(member["addedAmount"], "team member contribution")
	check(n(pkg["minShare"]) > 0 && cost%n(pkg["minShare"]) == 0, "Invalid team share price")
	shares := cost / n(pkg["minShare"])
	check(cost == money(before, "costBtc") && shares == n(before["shares"]) && (s(member["paymentStatus"]) == "" || s(member["paymentStatus"]) == "OK"), "Team participation changed; sync before adding shares")
	for k, v := range obj(member["shares"]) {
		check(k == "small" || n(v) == 0, "Automatic additions support small shares without coupons or mass buys")
	}
	if obj(member["shares"])["small"] != nil {
		check(n(obj(member["shares"])["small"]) == shares, "Share quantity does not match the verified contribution")
	}
	return pkg, fundingRecord(paymentMarket(q), M{"beforeCostBtc": cost, "beforeShares": shares, "targetCostBtc": cost + money(q, "costBtc"), "targetShares": shares + n(st["shares"])})
}
func setOrderTotal(o M, cost, fee int64, when, note string) {
	before := netCost(o)
	history := spendEntries(o)
	setMoney(o, "costBtc", cost)
	setMoney(o, "feeBtc", fee)
	change := netCost(o) - before
	if change != 0 {
		o["spendHistory"] = append(history, spendEntry(paymentMarket(o), when, change, note))
	}
}
func (e *Engine) execute(ctx context.Context, st, q M, owner, twofa string, review, destination M) M {
	settings := obj(e.Store.Get("settings"))
	live := s(settings["mode"]) == "live"
	manual := review != nil
	buying := clone(st)
	if q["teamLevel"] != nil {
		buying["shares"] = q["shares"]
	}
	before := findBy(e.Store.List("orders"), "id", q["parentOrderId"])
	check(purchaseProfile(settings) != "guide" || before == nil, "The guide shares-only format supports first joins; cumulative additions require the documented or web format")
	if trace := debugTrace(ctx); trace != nil {
		for _, k := range []string{"payoutAddress", "mergePayoutAddress"} {
			if s(buying[k]) != "" {
				trace.redactions = append(trace.redactions, s(buying[k]))
			}
		}
		if twofa != "" {
			trace.redactions = append(trace.redactions, twofa)
		}
	}
	var update M
	pkg := findBy(maps(e.Store.Get("packages")), "id", q["id"])
	if live {
		if destination == nil {
			destination = e.Client().Destination(ctx, q, buying)
		}
		if manual {
			check(!b(destination["requiresTwofa"]) || regexp.MustCompile(`^\d{6,8}$`).MatchString(twofa), "Enter a current NiceHash 2FA code for this unsaved payout address")
		}
		if !manual {
			check(!b(destination["requiresTwofa"]), "Save the payout address in NiceHash before automatic buying")
		}
		if before != nil {
			var prepared M
			prepared, update = e.prepareAddition(ctx, q, buying, before)
			debugStep(ctx, "owned_addition_verified", pick(update, []string{"market", "beforeCostBtc", "beforeAmount", "beforeShares", "targetCostBtc", "targetAmount", "targetShares"}))
			pkg = prepared
			q = merge(q, prepared, M{"costBtc": safeMul(money(prepared, "costBtc"), n(buying["shares"]))})
			q = fundingRecord(paymentMarket(prepared), q)
		}
	}
	reason := guard(e.Store.State(), st, q, time.Now(), manual)
	debugStep(ctx, "final_guard", M{"passed": reason == "", "reason": reason, "manual": manual, "limits": pick(marketLimits(settings, paymentMarket(q)), []string{"dailyCap", "weeklyCap", "monthlyCap", "maxOrder", "reserve", "maxActive", "feeBufferBps"})})
	if reason != "" {
		conflict(reason)
	}
	check(e.Store.Owns(owner), "Purchase lock expired before submission")
	check(s(obj(e.Store.Get("settings"))["mode"]) == s(settings["mode"]), "Execution mode changed")
	if manual {
		check(time.Now().Before(parseTime(review["expiresAt"])), "Purchase review expired; review again")
		check(s(e.Credentials()["orgId"]) == s(review["orgId"]), "Account changed; review again")
	}
	when := stamp()
	previousBuy := st["lastBuyAt"]
	shares := int64(1)
	if b(q["team"]) {
		shares = n(buying["shares"])
	}
	order := M{"id": uuid(), "requestId": uuid(), "mode": settings["mode"], "kind": buying["mode"], "strategyId": st["id"], "packageId": q["id"], "name": q["name"], "coin": q["coin"], "mergeCoin": q["mergeCoin"], "shares": shares, "costBtc": moneyValue(q, "costBtc"), "feeBtc": reserve(money(q, "costBtc"), settings) - money(q, "costBtc"), "refundBtc": 0, "createdAt": when, "status": "SUBMITTING", "odds": q["odds"], "reward": q["reward"], "rewardEstimate": purchaseEstimate(pkg, shares), "endAt": time.Now().Add(time.Duration(n(q["duration"])) * time.Second).UTC().Format(time.RFC3339Nano), "source": "Strategy engine", "externalId": nil}
	order["purchaseRequestProfile"] = purchaseProfile(settings)
	order = fundingRecord(paymentMarket(q), order)
	for k, v := range payoutFields(buying) {
		order[k] = v
	}
	if !live {
		order["source"] = "Paper simulation"
	}
	if live && b(q["team"]) {
		order["externalId"] = q["id"]
	}
	if manual {
		order["source"] = map[bool]string{true: "Manual web purchase", false: "Manual paper purchase"}[live]
		order["strategyId"] = nil
		order["requestId"] = review["id"]
	}
	var entry M
	if q["teamLevel"] != nil {
		entry = M{"threshold": obj(q["teamLevel"])["threshold"], "shares": shares, "amountBtc": moneyValue(q, "costBtc"), "requestId": order["requestId"], "createdAt": when, "status": "SUBMITTING"}
		entry = fundingRecord(paymentMarket(q), entry)
		if before != nil {
			order = clone(before)
			order["status"] = "SUBMITTING"
			buys := maps(order["teamBuys"])
			if len(buys) == 0 {
				buys = append(buys, fundingRecord(paymentMarket(before), M{"threshold": maps(st["teamLevels"])[0]["threshold"], "shares": before["shares"], "amountBtc": moneyValue(before, "costBtc"), "requestId": before["requestId"], "createdAt": before["createdAt"], "status": "CONFIRMED", "existingEntry": true}))
			}
			order["teamBuys"] = buys
		}
		order["teamBuys"] = append(maps(order["teamBuys"]), entry)
		var savedBefore any
		if before != nil {
			savedBefore = pick(before, []string{"market", "costBtc", "feeBtc", "costAmount", "feeAmount", "shares", "status", "spendHistory", "rewardEstimate"})
		}
		order["pendingTeamPurchase"] = fundingRecord(paymentMarket(q), M{"requestId": entry["requestId"], "targetCostBtc": money(before, "costBtc") + money(q, "costBtc"), "targetShares": n(before["shares"]) + shares, "before": savedBefore})
		if before == nil {
			setMoney(order, "costBtc", int64(0))
			setMoney(order, "feeBtc", int64(0))
		}
		setOrderTotal(order, money(before, "costBtc")+money(q, "costBtc"), money(before, "feeBtc")+reserve(money(q, "costBtc"), settings)-money(q, "costBtc"), when, "Team buying level reserved")
		order["shares"] = n(before["shares"]) + shares
		estimatePkg := clone(pkg)
		if live && before != nil {
			if integer(pkg["teamShares"]) {
				estimatePkg["teamShares"] = n(pkg["teamShares"]) - n(before["shares"])
			}
			if integer(pkg["teamCommitted"]) {
				estimatePkg["teamCommitted"] = n(pkg["teamCommitted"]) - money(before, "costBtc")
			}
		}
		order["rewardEstimate"] = purchaseEstimate(estimatePkg, n(order["shares"]))
	}
	if live && b(q["team"]) {
		order["purchaseCheck"] = e.purchaseCheck(q, buying, manual)
	}
	order["purchaseRequestProfile"] = purchaseProfile(settings)
	if trace := debugTrace(ctx); trace != nil {
		order["debugTraceId"] = trace.id
	}
	e.Store.Batch(func(tx *Store) {
		tx.Save("orders", order)
		if manual {
			review["orderId"] = order["id"]
			tx.Set("purchase-quote:"+s(review["id"]), review)
		} else {
			st["lastBuyAt"] = when
			tx.Save("strategies", st)
		}
	})
	debugStep(ctx, "intent_persisted", pick(order, []string{"id", "requestId", "mode", "market", "status", "costBtc", "costAmount", "feeBtc", "feeAmount", "shares", "debugTraceId", "purchaseRequestProfile"}))
	if !live {
		order["status"] = "ACTIVE"
		if entry != nil {
			// Release the paper fee buffer through the same dated journal as live.
			setOrderTotal(order, money(order, "costBtc"), 0, when, "Paper team level accepted; buffer released")
			entry["status"] = "CONFIRMED"
			delete(order, "pendingTeamPurchase")
		} else {
			setMoney(order, "feeBtc", 0)
		}
		e.Store.Save("orders", order)
		e.Store.Event("info", "Paper purchase: "+s(q["name"]))
		return order
	}
	// From this point every non-confirmed failure retains an UNKNOWN reservation.
	caught := attempt(func() {
		requestID := s(order["requestId"])
		if entry != nil {
			requestID = s(entry["requestId"])
		}
		result := e.Client().Buy(ctx, q, buying, requestID, twofa, destination, update)
		if entry != nil {
			check(s(result["id"]) == s(q["id"]) && money(result, "costBtc") == money(q, "costBtc"), "Team level response requires verification")
			entry["status"] = "PENDING"
			setOrderTotal(order, money(obj(order["pendingTeamPurchase"]), "targetCostBtc"), 0, when, "Team level accepted; buffer released")
			order["status"] = "PENDING"
		} else {
			order["externalId"] = result["id"]
			setMoney(order, "costBtc", moneyValue(result, "costBtc"))
			setMoney(order, "feeBtc", 0)
			order["status"] = normalizeStatus(result["status"])
		}
		// Persist an accepted receipt with the order. Telegram observes it later;
		// no notification network operation runs inside a purchase or its retry path.
		receipt := M{"requestId": requestID, "at": stamp(), "amount": money(result, "costBtc"), "shares": shares, "totalAmount": money(order, "costBtc"), "totalShares": order["shares"]}
		if entry != nil {
			receipt["threshold"] = entry["threshold"]
		}
		order["purchaseReceipts"] = append(maps(order["purchaseReceipts"]), receipt)
		if entry != nil {
			order["syncPending"] = M{"since": when, "checkedAt": stamp(), "reason": "Purchase accepted; waiting for team membership details before adding more shares to this team", "stage": "team-confirmation", "blocking": false, "proof": "accepted-purchase"}
		}
		e.Store.Save("orders", order)
		rt := obj(e.Store.Get("runtime"))
		balances := obj(rt["balances"])
		market := paymentMarket(q)
		balances[market] = max(0, n(marketBalance(rt, market))-money(result, "costBtc"))
		patch := M{"balances": balances}
		if market == "BTC" {
			patch["balance"] = balances[market]
		}
		e.runtime(patch)
		e.Store.Event("info", "Live purchase accepted: "+s(q["name"])+" · "+s(result["id"]))
		if money(result, "costBtc") > n(st["maxPrice"]) || money(result, "costBtc") > n(marketLimits(settings, paymentMarket(q))["maxOrder"]) {
			e.Pause("Provider price exceeded the checked ceiling")
		}
		if s(order["status"]) == "UNKNOWN" {
			e.Pause("Purchase response requires reconciliation")
		}
	})
	if caught != nil {
		api, ok := caught.(*APIError)
		if !ok {
			api = &APIError{Method: "POST", RequestID: s(order["requestId"]), Uncertain: true, Message: panicError(caught).Error()}
			if b(q["team"]) {
				api.Path = e.Client().TeamBuyPath(s(q["id"]))
			} else {
				api.Path = e.Client().SoloBuyPath()
			}
		}
		rejected := api.Rejected()
		failure := M{"at": stamp(), "rejected": rejected, "uncertain": !rejected, "httpStatus": api.HTTPStatus, "code": api.Code, "method": api.Method, "path": api.Path, "requestId": api.RequestID, "providerMessage": api.ProviderMessage, "request": api.Trace, "providerErrorId": api.ProviderErrorID}
		if trace := debugTrace(ctx); trace != nil {
			failure["debugTraceId"] = trace.id
		}
		failure["purchaseRequestProfile"] = purchaseProfile(settings)
		order["status"] = "UNKNOWN"
		order["error"] = api.Error()
		order["submissionFailure"] = failure
		if entry != nil {
			entry["status"] = "UNKNOWN"
			entry["error"] = api.Error()
			entry["failure"] = failure
		}
		if rejected {
			order["status"] = "FAILED"
			setMoney(order, "requestedCostBtc", moneyValue(order, "costBtc"))
			setMoney(order, "feeBtc", 0)
			delete(order, "syncPending")
			if b(q["team"]) && s(order["externalId"]) == s(q["id"]) {
				order["attemptedTeamId"] = order["externalId"]
				order["externalId"] = nil
			}
			if entry != nil {
				entry["status"] = "FAILED"
				if before != nil {
					buys := order["teamBuys"]
					order = clone(before)
					order["teamBuys"] = buys
					order["lastTeamPurchaseFailure"] = failure
				} else {
					delete(order, "pendingTeamPurchase")
				}
			}
			if !manual {
				st["lastBuyAt"] = previousBuy
				e.Store.Save("strategies", st)
			}
		}
		if trace := debugTrace(ctx); trace != nil {
			order["debugTraceId"] = trace.id
		}
		e.Store.Save("orders", order)
		if rejected && b(q["team"]) && (api.HTTPStatus == 404 || api.HTTPStatus == 410 || api.TeamStateRejected()) {
			checkData := clone(obj(order["purchaseCheck"]))
			if len(checkData) == 0 {
				checkData = e.purchaseCheck(q, buying, manual)
			}
			after := M{"checkedAt": stamp()}
			inspection := attempt(func() {
				packages := e.Client().Packages(ctx)
				matched := findBy(packages, "id", q["id"])
				after["listed"] = matched != nil
				after["team"] = teamSnapshot(matched)
				finding := "not-listed-after-rejection"
				if matched != nil {
					finding = "closed-after-rejection"
					if b(matched["available"]) {
						finding = "still-listed-after-rejection"
					}
				}
				checkData["finding"] = finding
			})
			if inspection != nil {
				checkData["finding"] = "verification-read-failed"
				if a, ok := inspection.(*APIError); ok {
					after["httpStatus"] = a.HTTPStatus
				}
			}
			checkData["after"] = after
			if trace := debugTrace(ctx); trace != nil {
				debugStep(ctx, "team_after_rejection", M{"finding": checkData["finding"], "listed": after["listed"], "team": debugSafeSnapshot(trace, obj(after["team"]))})
			}
			failure["teamCheck"] = checkData
			e.Store.Save("orders", order)
		} else {
			e.Pause(api.Error())
		}
		e.RecordError(api)
	}
	return order
}
func pick(value M, keys []string) M {
	out := M{}
	for _, k := range keys {
		if has(value, k) {
			out[k] = value[k]
		}
	}
	return out
}
func (e *Engine) Quote(ctx context.Context, input M) any {
	return e.exclusive(func(string) any {
		packages := e.RefreshPackages(ctx)
		p := findBy(packages, "id", input["packageId"])
		check(p != nil && b(p["available"]), "Package is no longer available; refresh the catalogue")
		check(supportedMarket(paymentMarket(p)), "Unsupported package payment market")
		shares := first(input["shares"], 1)
		check(integer(shares) && n(shares) >= 1 && n(shares) <= 100 && (b(p["team"]) || n(shares) == 1), "Choose 1–100 team shares, or one solo package")
		settings := obj(e.Store.Get("settings"))
		cost := safeMul(money(p, "costBtc"), n(shares))
		check(cost > 0, "Invalid package price")
		q := merge(payoutFields(input), M{"id": uuid(), "mode": settings["mode"], "orgId": e.Credentials()["orgId"], "packageId": p["id"], "name": p["name"], "coin": p["coin"], "mergeCoin": p["mergeCoin"], "team": p["team"], "shares": n(shares), "costBtc": cost, "reservedBtc": reserve(cost, settings), "rewardEstimate": purchaseEstimate(p, n(shares)), "createdAt": stamp(), "expiresAt": time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339Nano)})
		q["purchaseRequestProfile"] = purchaseProfile(settings)
		q = fundingRecord(paymentMarket(p), q)
		if s(settings["mode"]) == "live" {
			q["requiresTwofa"] = e.Client().Destination(ctx, p, q)["requiresTwofa"]
		}
		e.Store.Set("purchase-quote:"+s(q["id"]), q)
		e.Store.Exec("DELETE FROM kv WHERE key LIKE 'purchase-quote:%' AND json_extract(value,'$.orderId') IS NULL AND json_extract(value,'$.expiresAt') < ?", stamp())
		return q
	})
}
func manualStrategy(q M) M {
	return merge(defaultStrategy(), payoutFields(q), M{"id": "manual:" + s(q["id"]), "market": paymentMarket(q), "continuous": false, "enabled": true, "stopOnWin": false, "minTeamShares": 0, "mode": map[bool]string{true: "team", false: "solo"}[b(q["team"])], "coin": q["coin"], "shares": q["shares"], "maxPrice": moneyValue(q, "costBtc"), "budget": moneyValue(q, "reservedBtc"), "maxPurchases": 1})
}
func (e *Engine) ManualBuy(ctx context.Context, input M) any {
	check(uuidRE.MatchString(s(input["quoteId"])), "Invalid purchase review ID")
	return e.exclusive(func(owner string) any {
		var finish func()
		ctx, finish = e.beginPurchaseDebug(ctx, "manual purchase")
		defer finish()
		review := obj(e.Store.Get("purchase-quote:" + s(input["quoteId"])))
		check(len(review) > 0, "Purchase review was not found; review the package again")
		if s(review["orderId"]) != "" {
			o := findBy(e.Store.List("orders"), "id", review["orderId"])
			check(o != nil, "Purchase needs administrator reconciliation")
			return M{"order": o, "replayed": true}
		}
		check(time.Now().Before(parseTime(review["expiresAt"])), "Purchase review expired; review the latest price")
		settings := obj(e.Store.Get("settings"))
		check(purchaseProfile(settings) == purchaseProfile(review), "Purchase API format changed; review the package again")
		check(s(settings["mode"]) == s(review["mode"]) && s(e.Credentials()["orgId"]) == s(review["orgId"]), "Mode or account changed; review again")
		if s(settings["mode"]) == "live" {
			check(b(settings["liveArmed"]), "Arm live buying before submitting a real purchase")
			e.sync(ctx)
		}
		packages := e.RefreshPackages(ctx)
		p := findBy(packages, "id", review["packageId"])
		check(p != nil && s(p["coin"]) == s(review["coin"]) && s(p["mergeCoin"]) == s(review["mergeCoin"]), "Package changed; review again")
		q := merge(p, M{"costBtc": safeMul(money(p, "costBtc"), n(review["shares"]))})
		check(paymentMarket(p) == paymentMarket(review), "Package payment market changed; review again")
		q = fundingRecord(paymentMarket(p), q)
		st := manualStrategy(review)
		if trace := debugTrace(ctx); trace != nil {
			trace.network = true
		}
		reason := guard(e.Store.State(), st, q, time.Now(), true)
		debugDecision(ctx, st, q, reason)
		if reason != "" {
			conflict(reason)
		}
		order := e.execute(ctx, st, q, owner, s(input["twofaToken"]), review, nil)
		debugPurchaseResult(ctx, order)
		return M{"order": order, "replayed": false}
	})
}
func (e *Engine) settlePaper() {
	rt := obj(e.Store.Get("runtime"))
	rates := merge(obj(obj(rt["exchangeRates"])["btc"]), obj(rt["rates"]))
	for _, o := range e.Store.List("orders") {
		if s(o["mode"]) != "paper" || s(o["status"]) != "ACTIVE" || time.Now().Before(parseTime(o["endAt"])) {
			continue
		}
		o["status"] = "COMPLETED"
		e.Store.Save("orders", o)
		random, err := rand.Int(rand.Reader, big.NewInt(1000000000))
		must(err)
		odds := f(o["odds"])
		if odds <= 0 || float64(random.Int64())/1e9 >= 1/odds {
			continue
		}
		if o["rewardEstimate"] == nil && s(o["kind"]) != "team" {
			o["rewardEstimate"] = purchaseEstimate(M{"coin": o["coin"], "reward": o["reward"], "team": false}, 1)
		}
		for _, block := range maps(obj(o["rewardEstimate"])["blocks"]) {
			if !integer(block["amount"]) {
				continue
			}
			var value any
			if s(block["coin"]) == "BTC" {
				value = block["amount"]
			} else if f(rates[s(block["coin"])]) > 0 {
				value = round(float64(n(block["amount"])) * f(rates[s(block["coin"])]))
			}
			reward := M{"id": "paper:" + s(o["id"]) + ":" + s(block["coin"]), "orderId": o["id"], "coin": block["coin"], "amount": block["amount"], "confirmed": true, "scope": obj(o["rewardEstimate"])["scope"], "valueBtc": value, "createdAt": stamp(), "confirmedAt": stamp(), "valuation": "SIMULATED personal reward from purchase allocation"}
			usdtRewardValue(reward, rates)
			e.Store.Save("rewards", reward)
		}
		e.Store.Save("orders", o)
	}
}
