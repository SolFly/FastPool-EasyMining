package controller

import (
	"context"
	"net/url"
	"strings"
)

// Purchases use one explicitly selected format, without POST fallback or replay.
func purchaseProfile(settings M) string {
	if contains([]string{"documented", "web", "guide"}, s(settings["purchaseRequestProfile"])) {
		return s(settings["purchaseRequestProfile"])
	}
	return "documented"
}
func purchasePrefix(profile string) string {
	if profile == "web" || profile == "guide" {
		return "/hashpower"
	}
	return "/main"
}
func teamPurchasePath(profile, id string) string {
	return purchasePrefix(profile) + "/api/v2/hashpower/shared/ticket/" + id
}
func soloPurchasePath(profile string) string {
	return purchasePrefix(profile) + "/api/v2/hashpower/solo/order"
}
func purchaseProfiles() []M {
	return []M{
		{"id": "documented", "name": "Documented / v1.2.4", "prefix": "/main", "teamBody": "amount + shares + clear", "additions": true},
		{"id": "web", "name": "NiceHash web client", "prefix": "/hashpower", "teamBody": "amount + shares + clear", "additions": true},
		{"id": "guide", "name": "Integration guide", "prefix": "/hashpower", "teamBody": "shares only", "additions": false},
	}
}
func (api *NiceHash) TeamBuyPath(id string) string { return teamPurchasePath(api.PurchaseProfile, id) }
func (api *NiceHash) SoloBuyPath() string          { return soloPurchasePath(api.PurchaseProfile) }
func (api *NiceHash) TicketListPath(team bool) string {
	part := ""
	if team {
		part = "shared/"
	}
	return purchasePrefix(api.PurchaseProfile) + "/api/v2/hashpower/solo/" + part + "order"
}
func (api *NiceHash) TicketRewardsPath(id string) string {
	check(uuidRE.MatchString(id), "Invalid NiceHash ticket ID")
	return purchasePrefix(api.PurchaseProfile) + "/api/v2/hashpower/order/" + id + "/rewards"
}

// Only these private, read-only resources can use the alternate gateway. This
// helper is never used by Request/Buy, so it cannot replay or reroute a POST.
func historyReadClass(path string) (string, string, string) {
	for _, prefix := range []string{"/main", "/hashpower"} {
		if !strings.HasPrefix(path, prefix+"/") {
			continue
		}
		suffix := strings.TrimPrefix(path, prefix)
		for _, part := range []string{"/api/v2/hashpower/solo/order", "/api/v2/hashpower/solo/shared/order"} {
			if suffix == part {
				return prefix, suffix, part
			}
			if strings.HasPrefix(suffix, part+"/") && uuidRE.MatchString(strings.TrimPrefix(suffix, part+"/")) {
				return prefix, suffix, part + "/{id}"
			}
		}
		part := "/api/v2/hashpower/order/"
		if strings.HasPrefix(suffix, part) && strings.HasSuffix(suffix, "/rewards") && uuidRE.MatchString(strings.TrimSuffix(strings.TrimPrefix(suffix, part), "/rewards")) {
			return prefix, suffix, part + "{id}/rewards"
		}
	}
	return "", "", ""
}

func (api *NiceHash) historyGet(ctx context.Context, path string, query url.Values) any {
	prefix, suffix, class := historyReadClass(path)
	if class == "" {
		return api.Get(ctx, path, query, true)
	}
	if cached := api.HistoryReadPrefixes[class]; cached != "" {
		prefix = cached
	}
	var result any
	caught := attempt(func() { result = api.Get(ctx, prefix+suffix, query, true) })
	if caught == nil {
		return result
	}
	err, ok := caught.(*APIError)
	if !ok || err.Method != "GET" || err.HTTPStatus != 404 || s(err.Code) != "110" {
		panic(caught)
	}
	alternate := "/main"
	if prefix == "/main" {
		alternate = "/hashpower"
	}
	if len(api.HistoryReadFallbacks) < 20 {
		api.HistoryReadFallbacks = append(api.HistoryReadFallbacks, M{"fromPath": prefix + suffix, "toPath": alternate + suffix, "httpStatus": 404, "code": "110", "checkedAt": stamp()})
	}
	result = api.Get(ctx, alternate+suffix, query, true)
	if api.HistoryReadPrefixes == nil {
		api.HistoryReadPrefixes = map[string]string{}
	}
	api.HistoryReadPrefixes[class] = alternate
	return result
}
func (api *NiceHash) TeamBody(q, st, fields, update M) teamBuyBody {
	body := makeTeamBuyBody(q, st, fields, update)
	if api.PurchaseProfile == "guide" {
		check(update == nil, "The guide shares-only format is limited to first joins; use the documented or web format for cumulative additions")
		body.Amount = ""
		body.Clear = nil
	}
	return body
}
func (api *NiceHash) PurchaseTeamDetails(ctx context.Context, id string) M {
	return api.Ticket(ctx, id, true)
}
