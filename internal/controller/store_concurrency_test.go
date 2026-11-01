package controller

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func databaseResult(t *testing.T, done <-chan any, task string) any {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(8 * time.Second):
		t.Fatalf("%s did not finish", task)
		return nil
	}
}

func TestQueuedWritersLeaveImportCredentialReadsAvailable(t *testing.T) {
	st := OpenStore(t.TempDir())
	defer st.Close()
	read, proceed, readDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	batchDone, writersDone := make(chan any, 1), make(chan any, 8)
	started := make(chan struct{}, 8)
	go func() {
		batchDone <- attempt(func() {
			st.Batch(func(tx *Store) {
				tx.Get("settings")
				close(read)
				<-proceed
				// Real imports read credentials/rates through their root store while
				// their ledger transaction is active. Queued writers cannot consume
				// every connection and prevent that read from finishing.
				st.Get("settings")
				close(readDone)
				tx.Save("orders", M{"id": "team", "costBtc": 300000})
			})
		})
	}()
	<-read
	for i := 0; i < 8; i++ {
		go func() { started <- struct{}{}; writersDone <- attempt(func() { st.Set("maintenance", stamp()) }) }()
	}
	for i := 0; i < 8; i++ {
		<-started
	}
	// Allow the competing writers to enter their queues before the root read.
	<-time.After(100 * time.Millisecond)
	close(proceed)
	readBlocked := false
	select {
	case <-readDone:
	case <-time.After(2 * time.Second):
		readBlocked = true
	}
	batchError := databaseResult(t, batchDone, "import with credential read")
	for i := 0; i < 8; i++ {
		assert(t, databaseResult(t, writersDone, "queued writer") == nil, "Queued writer failed")
	}
	assert(t, !readBlocked && batchError == nil && n(st.List("orders")[0]["costBtc"]) == 300000, "Queued writers starved the import's root read: %v", batchError)
}

func TestLedgerSnapshotAlsoExcludesIndependentConnectionWriters(t *testing.T) {
	st := OpenStore(t.TempDir())
	defer st.Close()
	external, err := sql.Open("sqlite3", filepath.Join(st.Dir, "controller.sqlite")+"?_busy_timeout=2000&_journal_mode=WAL")
	must(err)
	defer external.Close()
	must(external.Ping())
	read, release := make(chan struct{}), make(chan struct{})
	batchDone, writerDone := make(chan any, 1), make(chan any, 1)
	go func() {
		batchDone <- attempt(func() {
			st.Batch(func(tx *Store) {
				tx.Get("settings")
				close(read)
				<-release
				tx.Save("orders", M{"id": "team", "costBtc": 300000})
			})
		})
	}()
	<-read
	go func() {
		writerDone <- attempt(func() { _, err := external.Exec("UPDATE lease SET until_ms=123 WHERE id=1"); must(err) })
	}()
	finishedEarly := false
	var result any
	select {
	case result = <-writerDone:
		finishedEarly = true
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	batchError := databaseResult(t, batchDone, "ledger snapshot")
	if !finishedEarly {
		result = databaseResult(t, writerDone, "independent writer")
	}
	assert(t, !finishedEarly && batchError == nil && result == nil, "Independent writer invalidated snapshot: early=%v batch=%v writer=%v", finishedEarly, batchError, result)
}

func TestFailedLedgerBatchRollsBackAndNeverReplaysItsCallback(t *testing.T) {
	st := OpenStore(t.TempDir())
	defer st.Close()
	st.Save("orders", M{"id": "original", "externalId": testTeam, "costBtc": 300000})
	calls := 0
	caught := attempt(func() {
		st.Batch(func(tx *Store) {
			calls++
			tx.Save("orders", M{"id": "partial", "costBtc": 10000})
			tx.Save("orders", M{"id": "duplicate", "externalId": testTeam, "costBtc": 10000})
		})
	})
	assert(t, caught != nil && calls == 1 && len(st.List("orders")) == 1 && n(st.List("orders")[0]["costBtc"]) == 300000, "Failed batch committed partial spending or replayed a callback")
	st.Set("after-rollback", true)
	assert(t, b(st.Get("after-rollback")), "Rollback kept the writer gate locked")
}

func TestLedgerBatchSurvivesConcurrentMaintenanceWrites(t *testing.T) {
	for _, maintenance := range []string{"lease renewal", "notification status"} {
		t.Run(maintenance, func(t *testing.T) {
			st := OpenStore(t.TempDir())
			defer st.Close()
			assert(t, st.Acquire("owner"), "Cannot acquire fixture lease")
			read, release := make(chan struct{}), make(chan struct{})
			batchDone, writerDone := make(chan any, 1), make(chan any, 1)
			go func() {
				batchDone <- attempt(func() {
					st.Batch(func(tx *Store) {
						tx.List("orders") // establish the ledger read snapshot
						close(read)
						<-release
						tx.Save("orders", M{"id": "completed-team", "status": "COMPLETED", "mode": "live", "kind": "team", "costBtc": 300000})
					})
				})
			}()
			<-read
			go func() {
				writerDone <- attempt(func() {
					if maintenance == "lease renewal" {
						st.Renew("owner")
					} else {
						st.Set("telegramStatus", M{"lastSentAt": stamp()})
					}
				})
			}()
			// A maintenance write must wait outside an in-flight ledger snapshot;
			// otherwise SQLite rejects its later read-to-write upgrade immediately.
			var early any
			finishedEarly := false
			select {
			case early = <-writerDone:
				finishedEarly = true
			case <-time.After(100 * time.Millisecond):
			}
			close(release)
			batchError := databaseResult(t, batchDone, "ledger batch")
			writerError := early
			if !finishedEarly {
				writerError = databaseResult(t, writerDone, "maintenance write")
			}
			assert(t, !finishedEarly && batchError == nil && writerError == nil, "Concurrent %s invalidated the ledger snapshot: early=%v batch=%v maintenance=%v", maintenance, finishedEarly, batchError, writerError)
			assert(t, n(st.List("orders")[0]["costBtc"]) == 300000 && st.Owns("owner"), "Lost commitment or lease")
		})
	}
}
