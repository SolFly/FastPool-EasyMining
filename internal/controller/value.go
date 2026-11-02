package controller

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const Version = "2.2.5-go"
const Sat int64 = 100000000
const MaxSafe int64 = 9007199254740991

type M = map[string]any

func obj(v any) M {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return M{}
}
func arr(v any) []any {
	if a, ok := v.([]any); ok && a != nil {
		return a
	}
	return []any{}
}
func maps(v any) []M {
	if x, ok := v.([]M); ok {
		return x
	}
	r := []M{}
	for _, x := range arr(v) {
		r = append(r, obj(x))
	}
	return r
}
func s(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return string(x)
	}
	return fmt.Sprint(v)
}
func n(v any) int64 {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int64:
		return x
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0
		}
		return int64(x)
	case json.Number:
		i, _ := x.Int64()
		if i == 0 {
			f, _ := x.Float64()
			return int64(f)
		}
		return i
	}
	return 0
}
func f(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case json.Number:
		r, _ := x.Float64()
		return r
	case string:
		r, _ := strconv.ParseFloat(x, 64)
		return r
	}
	return 0
}
func b(v any) bool { x, _ := v.(bool); return x }
func integer(v any) bool {
	switch v.(type) {
	case json.Number, float64, int, int64:
		x := f(v)
		return !math.IsNaN(x) && !math.IsInf(x, 0) && math.Trunc(x) == x && math.Abs(x) <= float64(MaxSafe)
	}
	return false
}
func has(m M, k string) bool { _, ok := m[k]; return ok }
func first(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
func strfirst(v ...any) string {
	for _, x := range v {
		if s(x) != "" {
			return s(x)
		}
	}
	return ""
}
func merge(ms ...M) M {
	r := M{}
	for _, m := range ms {
		for k, v := range m {
			r[k] = v
		}
	}
	return r
}
func clone(m M) M { return obj(decode(encode(m))) }
func encode(v any) []byte {
	var out bytes.Buffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	must(e.Encode(v))
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'})
}
func decode(data []byte) any {
	var v any
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	must(d.Decode(&v))
	var extra any
	check(d.Decode(&extra) == io.EOF, "Unexpected trailing JSON data")
	return v
}
func must(e error) {
	if e != nil {
		panic(e)
	}
}

type Problem struct {
	Status        int
	Message, Code string
}

func (e Problem) Error() string { return e.Message }
func fail(message string)       { panic(Problem{400, message, ""}) }
func conflict(message string)   { panic(Problem{409, message, ""}) }
func check(ok bool, message string) {
	if !ok {
		fail(message)
	}
}
func uuid() string {
	var a [16]byte
	_, e := rand.Read(a[:])
	must(e)
	a[6] = (a[6] & 15) | 64
	a[8] = (a[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", a[:4], a[4:6], a[6:8], a[8:10], a[10:])
}
func stamp() string             { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func parseTime(v any) time.Time { t, _ := time.Parse(time.RFC3339Nano, s(v)); return t }
func status(v any) string       { return strfirst(obj(v)["code"], v) }
func contains(list []string, x string) bool {
	for _, v := range list {
		if v == x {
			return true
		}
	}
	return false
}
func addUnique(values []any, more ...any) []any {
	for _, x := range more {
		if s(x) == "" {
			continue
		}
		found := false
		for _, v := range values {
			if s(v) == s(x) {
				found = true
				break
			}
		}
		if !found {
			values = append(values, x)
		}
	}
	return values
}

var decimalRE = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$`)

func rational(v any, field string) *big.Rat {
	for depth := 0; depth < 3; depth++ {
		m, ok := v.(map[string]any)
		if !ok {
			break
		}
		if has(m, "value") {
			v = m["value"]
		} else if has(m, "amount") {
			v = m["amount"]
		} else {
			break
		}
	}
	text := strings.TrimSpace(s(v))
	check(len(text) <= 512 && decimalRE.MatchString(text), "NiceHash "+field+": invalid decimal amount")
	if match := decimalRE.FindStringSubmatch(text); len(match) > 1 && match[1] != "" {
		exp, e := strconv.Atoi(match[1])
		check(e == nil && exp >= -1000 && exp <= 1000, "NiceHash "+field+": decimal exponent is outside the supported range")
	}
	r, ok := new(big.Rat).SetString(text)
	check(ok && r.Sign() >= 0, "NiceHash "+field+": amount must be nonnegative")
	return r
}
func fromRational(r *big.Rat, exact bool, field string) int64 {
	x := new(big.Rat).Mul(r, big.NewRat(Sat, 1))
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(x.Num(), x.Denom(), rem)
	check(!exact || rem.Sign() == 0, "NiceHash "+field+": nonzero precision below one ledger unit")
	check(q.IsInt64() && q.Int64() <= MaxSafe, "NiceHash "+field+": amount exceeds safe ledger precision")
	return q.Int64()
}
func units(v any, field string) int64 { return fromRational(rational(v, field), true, field) }
func sumUnits(rows []any, field string) int64 {
	r := new(big.Rat)
	for _, v := range rows {
		r.Add(r, rational(v, field))
	}
	return fromRational(r, false, field)
}
func decimal(v int64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	return fmt.Sprintf("%s%d.%08d", sign, v/Sat, v%Sat)
}
func amountJSON(v int64) json.Number {
	return json.Number(strings.TrimRight(strings.TrimRight(decimal(v), "0"), "."))
}
func netCost(o M) int64 { return money(o, "costBtc") + money(o, "feeBtc") - money(o, "refundBtc") }
func funded(o M) bool   { return current(o) && !contains([]string{"FAILED", "REJECTED"}, s(o["status"])) }
func current(o M) bool  { return s(o["supersededBy"]) == "" && s(o["status"]) != "SUPERSEDED" }
func held(o M) bool     { return s(obj(o["attribution"])["state"]) == "review" }
func pending(o M) bool {
	return current(o) && contains([]string{"ACTIVE", "PENDING", "SUBMITTING", "UNKNOWN"}, s(o["status"]))
}
func accounted(o M) bool { return current(o) && !held(o) }
func safeMul(a, c int64) int64 {
	check(a >= 0 && c >= 0 && (c == 0 || a <= MaxSafe/c), "Amount too large")
	return a * c
}
func reserve(cost int64, settings M) int64 {
	return cost + (safeMul(cost, n(settings["feeBufferBps"]))+9999)/10000
}

func rewardAccounted(r M) bool {
	return s(r["supersededBy"]) == "" && (r["excludedFromAccounting"] == nil || r["excludedFromAccounting"] == false || r["excludedFromAccounting"] == "") && n(r["confirmations"]) != -1 && !b(r["depositDonated"])
}
