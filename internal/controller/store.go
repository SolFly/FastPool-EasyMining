package controller

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/mattn/go-sqlite3"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type dbInterface interface {
	Exec(string, ...any) (sql.Result, error)
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}
type Store struct {
	db      *sql.DB
	q       dbInterface
	writeMu *sync.Mutex
	key     []byte
	Dir     string
}

func databaseFailure(caught any) M {
	var err sqlite3.Error
	if !errors.As(panicError(caught), &err) {
		return nil
	}
	return M{"source": "database", "dbCode": int(err.Code), "dbExtendedCode": int(err.ExtendedCode)}
}

// Queue writers before they take a database connection. Readers remain usable
// while a ledger transaction holds the writer, including credential reads made
// by import callbacks. Every root Exec (also lease/outbox CAS updates) uses this
// same gate; transaction children use their already-held sql.Tx directly.
type storeDatabase struct {
	db      *sql.DB
	writeMu *sync.Mutex
}

func (db *storeDatabase) Exec(query string, args ...any) (sql.Result, error) {
	db.writeMu.Lock()
	defer db.writeMu.Unlock()
	return db.db.Exec(query, args...)
}
func (db *storeDatabase) Query(query string, args ...any) (*sql.Rows, error) {
	return db.db.Query(query, args...)
}
func (db *storeDatabase) QueryRow(query string, args ...any) *sql.Row {
	return db.db.QueryRow(query, args...)
}

func OpenStore(dir string) *Store {
	must(os.MkdirAll(dir, 0700))
	keyPath := filepath.Join(dir, "master.key")
	key, e := os.ReadFile(keyPath)
	if os.IsNotExist(e) {
		if _, dbErr := os.Stat(filepath.Join(dir, "controller.sqlite")); dbErr == nil {
			fail("Existing database has no master.key. Restore the matching key before starting; credentials were not changed.")
		}
		key = make([]byte, 32)
		_, e = rand.Read(key)
		must(e)
		file, e := os.OpenFile(keyPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		must(e)
		_, e = file.Write(key)
		must(e)
		must(file.Close())
	} else {
		must(e)
	}
	check(len(key) == 32, "Invalid master.key")
	// Reserve the writer before reading a transaction snapshot. A deferred
	// read-to-write upgrade can otherwise fail immediately with BUSY_SNAPSHOT,
	// regardless of busy_timeout, when another process writes in between.
	db, e := sql.Open("sqlite3", filepath.Join(dir, "controller.sqlite")+"?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on&_txlock=immediate")
	must(e)
	db.SetMaxOpenConns(4)
	writeMu := &sync.Mutex{}
	st := &Store{db: db, q: &storeDatabase{db: db, writeMu: writeMu}, writeMu: writeMu, key: key, Dir: dir}
	must(db.Ping())
	_, e = db.Exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, external_id TEXT, data TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS orders_external ON orders(external_id) WHERE external_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchase_debug (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS telegram_outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO lease(id) VALUES (1);`)
	must(e)
	must(os.Chmod(filepath.Join(dir, "controller.sqlite"), 0600))
	if st.Get("settings") == nil {
		st.Set("settings", defaultSettings())
	}
	st.Batch(func(tx *Store) {
		settings := merge(defaultSettings(), obj(tx.Get("settings")))
		settings["running"] = false
		settings["liveArmed"] = false
		tx.Set("settings", settings)
		tx.Set("verified", false)
		for _, o := range tx.List("orders") {
			if s(o["status"]) == "SUBMITTING" {
				o["status"] = "UNKNOWN"
				tx.Save("orders", o)
			}
		}
		tx.Exec("UPDATE purchase_debug SET data=json_set(data,'$.outcome','interrupted','$.updatedAt',?) WHERE json_extract(data,'$.outcome')='running'", stamp())
		tx.Exec("DELETE FROM sessions")
	})
	return st
}
func (st *Store) Exec(query string, args ...any) { _, e := st.q.Exec(query, args...); must(e) }
func (st *Store) Get(key string) any {
	var value string
	e := st.q.QueryRow("SELECT value FROM kv WHERE key=?", key).Scan(&value)
	if e == sql.ErrNoRows {
		return nil
	}
	must(e)
	return decode([]byte(value))
}
func (st *Store) Set(key string, v any) {
	st.Exec("INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, string(encode(v)))
}
func (st *Store) List(table string) []M {
	check(contains([]string{"orders", "strategies", "rewards", "events"}, table), "Bad table")
	query := "SELECT data FROM " + table
	if table == "events" {
		query = "SELECT json_object('id',id,'at',at,'level',level,'message',message) FROM events ORDER BY id DESC LIMIT 300"
	}
	rows, e := st.q.Query(query)
	must(e)
	defer rows.Close()
	out := []M{}
	for rows.Next() {
		var data string
		must(rows.Scan(&data))
		out = append(out, obj(decode([]byte(data))))
	}
	must(rows.Err())
	if table == "orders" {
		sort.SliceStable(out, func(i, j int) bool { return s(out[i]["createdAt"]) > s(out[j]["createdAt"]) })
	}
	return out
}
func (st *Store) Save(table string, m M) {
	check(s(m["id"]) != "", "Missing record ID")
	switch table {
	case "orders":
		var ext any
		if s(m["externalId"]) != "" {
			ext = m["externalId"]
		}
		st.Exec("INSERT INTO orders(id,external_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,data=excluded.data", m["id"], ext, string(encode(m)))
	case "strategies", "rewards":
		st.Exec("INSERT INTO "+table+"(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", m["id"], string(encode(m)))
	default:
		fail("Bad table")
	}
}
func (st *Store) Event(level, message string) {
	if len(message) > 700 {
		message = message[:700]
	}
	st.Exec("INSERT INTO events(at,level,message) VALUES (?,?,?)", stamp(), level, message)
}
func (st *Store) Batch(fn func(*Store)) {
	st.writeMu.Lock()
	defer st.writeMu.Unlock()
	tx, e := st.db.Begin()
	must(e)
	defer tx.Rollback()
	child := *st
	child.q = tx
	fn(&child)
	must(tx.Commit())
}
func (st *Store) State() M {
	return M{"settings": st.Get("settings"), "strategies": st.List("strategies"), "orders": st.List("orders"), "rewards": st.List("rewards"), "packages": first(st.Get("packages"), []any{}), "events": st.List("events"), "runtime": first(st.Get("runtime"), M{})}
}
func (st *Store) Seal(v any) string {
	c, e := aes.NewCipher(st.key)
	must(e)
	g, e := cipher.NewGCM(c)
	must(e)
	iv := make([]byte, 12)
	_, e = rand.Read(iv)
	must(e)
	sealed := g.Seal(nil, iv, encode(v), nil)
	size := len(sealed)
	out := append(iv, sealed[size-16:]...)
	out = append(out, sealed[:size-16]...)
	return base64.StdEncoding.EncodeToString(out)
}
func (st *Store) Unseal(v string) M {
	raw, e := base64.StdEncoding.DecodeString(v)
	must(e)
	check(len(raw) >= 28, "Invalid encrypted credentials")
	c, e := aes.NewCipher(st.key)
	must(e)
	g, e := cipher.NewGCM(c)
	must(e)
	joined := append(append([]byte{}, raw[28:]...), raw[12:28]...)
	plain, e := g.Open(nil, raw[:12], joined, nil)
	must(e)
	return obj(decode(plain))
}
func (st *Store) Acquire(owner string) bool {
	r, e := st.q.Exec("UPDATE lease SET owner=?,until_ms=? WHERE id=1 AND until_ms < ?", owner, time.Now().UnixMilli()+180000, time.Now().UnixMilli())
	must(e)
	c, e := r.RowsAffected()
	must(e)
	return c == 1
}
func (st *Store) Owns(owner string) bool {
	var x int
	e := st.q.QueryRow("SELECT 1 FROM lease WHERE id=1 AND owner=? AND until_ms>?", owner, time.Now().UnixMilli()).Scan(&x)
	if e == sql.ErrNoRows {
		return false
	}
	must(e)
	return x == 1
}
func (st *Store) Renew(owner string) {
	st.Exec("UPDATE lease SET until_ms=? WHERE id=1 AND owner=?", time.Now().UnixMilli()+180000, owner)
}
func (st *Store) Release(owner string) {
	st.Exec("UPDATE lease SET until_ms=0,owner=NULL WHERE id=1 AND owner=?", owner)
}
func (st *Store) Close() { must(st.db.Close()) }
func (st *Store) SnapshotBeforeGo() {
	if st.Get("goMigrationVersion") != nil {
		return
	}
	backup := filepath.Join(st.Dir, "before-go-"+time.Now().UTC().Format("20060102T150405")+".sqlite")
	st.Exec("VACUUM INTO '" + stringsSQL(backup) + "'")
	must(os.Chmod(backup, 0600))
	st.Set("goMigrationVersion", Version)
	st.Event("info", fmt.Sprintf("Go runtime initialized; database snapshot: %s", filepath.Base(backup)))
}
func stringsSQL(v string) string {
	out := ""
	for _, r := range v {
		out += string(r)
		if r == '\'' {
			out += "'"
		}
	}
	return out
}
