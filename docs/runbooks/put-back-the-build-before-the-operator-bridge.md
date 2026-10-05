# Put back the build from before the operator bridge

Tier 3, and destructive: it returns the TangleClaw store to an earlier moment. Run by the
release executor, with the Operator's agreement and the Architect present.

## When to use this

v5.31.0 itself cannot start or stay healthy, and the previous build has to run.

## When NOT to use this

The bridge is misbehaving. That is [Roll the operator bridge back](roll-back-the-operator-bridge.md),
which stays on v5.31.0 and changes no store. This procedure is never a step of that one.

## What it costs

It is a rollback in time. The active TangleClaw store returns to the moment of
[the snapshot](activate-the-operator-bridge.md#snapshot). Everything written after that is
absent from the active store: sessions, workload and Medusa state, audit rows, the bridge's
settings, routes and items, and the rule and configuration changes made during activation.
The v5.31 store and its sidecar files are moved into a quarantine directory and kept, byte for
byte, but nothing merges them back.

## Prerequisites

- The cutover receipt the snapshot step wrote, in `~/.tangleclaw/cutovers`. Without it, stop:
  nothing here can be done from memory, and a digest recomputed from the snapshot proves nothing.
- The bridge helper is stopped and its job file removed: step 3 of
  [Roll the operator bridge back](roll-back-the-operator-bridge.md). The previous build has no
  helper, and a job file left in place would start it again at the next login.

## Steps

1. **Operator:** say that you agree to return the store to the snapshot and to lose what was
   written since. **Architect:** be present. Without both, do not go on.

2. <a id="restore"></a>**Release executor:** in a terminal, set `TC_RECEIPT` to the cutover
   receipt. Once the Operator has agreed, set `TC_OPERATOR_CONFIRMED=return-to-snapshot`: it is a
   guard against a paste by mistake, and it is not the Operator's agreement. Then paste this as
   it is. The parentheses matter: the first thing that fails stops the block, and nothing after
   it runs.

   ```sh
   (
   set -eu
   umask 077
   : "${TC_RECEIPT:?set TC_RECEIPT to the receipt: line the snapshot step printed}"
   [ "${TC_OPERATOR_CONFIRMED:-}" = "return-to-snapshot" ] || { echo "not confirmed: the Operator has not agreed to return the store to the snapshot" >&2; exit 1; }
   [ -f "$TC_RECEIPT" ] || { echo "no such receipt: $TC_RECEIPT" >&2; exit 1; }
   field() { sed -n "s/^$1=//p" "$TC_RECEIPT"; }
   CHECKOUT=$(field checkout)
   STORE=$(field store)
   SERVER=$(field server_label)
   HELPER=$(field helper_label)
   COMMIT=$(field from_commit)
   SNAPSHOT=$(field snapshot)
   DIGEST=$(field snapshot_sha256)
   SCHEMA=$(field snapshot_schema)
   for VALUE in "$CHECKOUT" "$STORE" "$SERVER" "$HELPER" "$COMMIT" "$SNAPSHOT" "$DIGEST" "$SCHEMA"; do
     [ -n "$VALUE" ] || { echo "the receipt is incomplete: $TC_RECEIPT" >&2; exit 1; }
   done
   expr "x$DIGEST" : 'x[0-9a-f]\{64\}$' >/dev/null || { echo "the receipt's sha256 is not a sha256: $TC_RECEIPT" >&2; exit 1; }
   expr "x$COMMIT" : 'x[0-9a-f]\{40\}$' >/dev/null || { echo "the receipt's commit is not a commit id: $TC_RECEIPT" >&2; exit 1; }
   expr "x$SCHEMA" : 'x[0-9]\{1,\}$' >/dev/null || { echo "the receipt's schema is not a number: $TC_RECEIPT" >&2; exit 1; }
   for LABEL in "$SERVER" "$HELPER"; do
     expr "x$LABEL" : 'xcom\.tangleclaw\.[A-Za-z0-9.-]\{1,\}$' >/dev/null || { echo "the receipt's job label is not a TangleClaw label: $LABEL" >&2; exit 1; }
   done
   PLIST="$HOME/Library/LaunchAgents/$SERVER.plist"
   JOB="gui/$(id -u)/$SERVER"
   HELPER_JOB="gui/$(id -u)/$HELPER"
   [ -z "$(field restore_begun)" ] || { echo "a restore was already begun from this receipt, so nothing was changed: $(field restore_quarantine)" >&2; exit 1; }
   grep -Fq "<string>$CHECKOUT</string>" "$PLIST" || { echo "the receipt's checkout is not the one the server job runs from: $PLIST" >&2; exit 1; }
   git -C "$CHECKOUT" cat-file -e "$COMMIT^{commit}"
   [ -s "$SNAPSHOT" ] || { echo "no such snapshot: $SNAPSHOT" >&2; exit 1; }
   SUM=$(shasum -a 256 "$SNAPSHOT")
   [ "${SUM%% *}" = "$DIGEST" ] || { echo "sha256 does not match the receipt: $SNAPSHOT" >&2; exit 1; }
   [ "$(sqlite3 -readonly "$SNAPSHOT" 'PRAGMA integrity_check')" = "ok" ] || { echo "integrity check failed: $SNAPSHOT" >&2; exit 1; }
   [ "$(sqlite3 -readonly "$SNAPSHOT" 'SELECT MAX(version) FROM schema_version')" = "$SCHEMA" ] || { echo "schema does not match the receipt: $SNAPSHOT" >&2; exit 1; }
   command -v lsof >/dev/null || { echo "lsof is needed to prove nothing has the store open" >&2; exit 1; }
   if SEEN=$(launchctl print "$HELPER_JOB" 2>&1); then echo "the bridge helper's job is still loaded, and the previous build has no helper: $HELPER_JOB" >&2; exit 1; fi
   case "$SEEN" in *"Could not find service"*) ;; *) echo "could not prove the helper's job is gone: $HELPER_JOB" >&2; exit 1 ;; esac
   [ ! -e "$HOME/Library/LaunchAgents/$HELPER.plist" ] || { echo "the bridge helper's job file is still installed, so the helper would come back at the next login: $HOME/Library/LaunchAgents/$HELPER.plist" >&2; exit 1; }
   [ -s "$STORE" ] || { echo "no store at the receipt's path: $STORE" >&2; exit 1; }
   [ "$(head -c 15 "$STORE")" = "SQLite format 3" ] || { echo "not a SQLite store: $STORE" >&2; exit 1; }
   launchctl bootout "$JOB" || echo "bootout did not succeed; checking the job itself"
   TRIES=0
   while SEEN=$(launchctl print "$JOB" 2>&1); do
     TRIES=$((TRIES + 1))
     [ "$TRIES" -lt 30 ] || { echo "the server job is still loaded: $JOB" >&2; exit 1; }
     sleep 1
   done
   case "$SEEN" in *"Could not find service"*) ;; *) echo "could not prove the server job is gone: $JOB" >&2; exit 1 ;; esac
   for FILE in "$STORE" "$STORE-journal" "$STORE-wal" "$STORE-shm"; do
     [ -e "$FILE" ] || continue
     HELD=$(lsof -Fp -- "$FILE" 2>&1) || true
     [ -z "$HELD" ] || { echo "still open, so nothing was changed: $FILE" >&2; echo "$HELD" >&2; exit 1; }
   done
   STAMP="${TC_RESTORE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
   CUTOVERS="$(dirname "$TC_RECEIPT")"
   QUARANTINE="$CUTOVERS/quarantine.$STAMP"
   PROBE="$CUTOVERS/probe.$STAMP"
   [ ! -e "$QUARANTINE" ] || { echo "refusing to reuse $QUARANTINE" >&2; exit 1; }
   mkdir "$PROBE"
   cp "$STORE" "$PROBE/probe.db"
   for SIDECAR in journal wal shm; do
     [ -e "$STORE-$SIDECAR" ] || continue
     cp "$STORE-$SIDECAR" "$PROBE/probe.db-$SIDECAR"
   done
   LIVE=$(sqlite3 "$PROBE/probe.db" 'SELECT MAX(version) FROM schema_version')
   rm -r "$PROBE"
   if [ "$LIVE" != "54" ]; then
     launchctl bootstrap "gui/$(id -u)" "$PLIST" || echo "the server could not be started again: $JOB" >&2
     echo "the store is at schema $LIVE, not 54, so this is not a store v5.31.0 migrated; it was not changed, and the server was started again: $STORE" >&2
     exit 1
   fi
   git -C "$CHECKOUT" checkout --detach "$COMMIT"
   mkdir "$QUARANTINE"
   printf '%s\n' "restore_begun=$STAMP" "restore_quarantine=$QUARANTINE" >> "$TC_RECEIPT"
   echo "quarantine: $QUARANTINE"
   for FILE in "$STORE" "$STORE-journal" "$STORE-wal" "$STORE-shm"; do
     [ -e "$FILE" ] || continue
     mv "$FILE" "$QUARANTINE/"
   done
   INCOMING="$STORE.incoming.$$"
   cp "$SNAPSHOT" "$INCOMING"
   chmod 600 "$INCOMING"
   SUM=$(shasum -a 256 "$INCOMING")
   [ "${SUM%% *}" = "$DIGEST" ] || { echo "the copy does not match the receipt: $INCOMING" >&2; exit 1; }
   mv "$INCOMING" "$STORE"
   launchctl bootstrap "gui/$(id -u)" "$PLIST"
   printf '%s\n' "restore_finished=$(date -u +%Y%m%dT%H%M%SZ)" >> "$TC_RECEIPT"
   echo "restored: $COMMIT with $SNAPSHOT"
   )
   ```

   → Expected: a line beginning `quarantine:`, a last line beginning `restored:`, and the
   dashboard loads on the previous build.
   → It stops before anything is changed, and nothing has been stopped, when it says: a name
   beginning `TC_`, "not confirmed", "no such receipt", "the receipt is incomplete", "is not a
   sha256", "is not a commit id", "is not a number", "is not a TangleClaw label", "a restore was
   already begun", "not the one the server job runs from", "no such snapshot", "does not match
   the receipt", "integrity check failed", "lsof is needed", "no store at the receipt's path",
   "not a SQLite store", "the bridge helper's job is still loaded", or "the bridge helper's job
   file is still installed"; or when git does not know the commit. Put right what it names and paste it again.
   → "still loaded", "could not prove the server job is gone" or "still open": the store is
   untouched; the server may be stopped. A line beginning `p` is the id of a process that has
   the file open. Stop nothing by name or pattern. Tell the Architect the ids and paths printed.
   → "the store is at schema … not 54": v5.31.0 never migrated this store. It was not changed,
   and the block started the server again on it. There is nothing to restore; tell the
   Architect. If it also says "the server could not be started again", the server is stopped
   and the store is untouched.
   → It stops at `checkout`: the server is stopped, the store is untouched, and git says why.
   Put that right and paste it again.
   → It stops after the `quarantine:` line: go to step 3. Do not paste this block again: it
   will refuse, because a second quarantine would hide the first.

3. <a id="finish"></a>**Release executor**, only if step 2 stopped after its `quarantine:` line:
   put right what it named, then paste this. It finishes that same restore, into that same
   quarantine, and never begins another.

   ```sh
   (
   set -eu
   umask 077
   : "${TC_RECEIPT:?set TC_RECEIPT to the receipt: line the snapshot step printed}"
   [ "${TC_OPERATOR_CONFIRMED:-}" = "return-to-snapshot" ] || { echo "not confirmed: the Operator has not agreed to return the store to the snapshot" >&2; exit 1; }
   [ -f "$TC_RECEIPT" ] || { echo "no such receipt: $TC_RECEIPT" >&2; exit 1; }
   field() { sed -n "s/^$1=//p" "$TC_RECEIPT"; }
   CHECKOUT=$(field checkout)
   STORE=$(field store)
   SERVER=$(field server_label)
   HELPER=$(field helper_label)
   COMMIT=$(field from_commit)
   SNAPSHOT=$(field snapshot)
   DIGEST=$(field snapshot_sha256)
   SCHEMA=$(field snapshot_schema)
   for VALUE in "$CHECKOUT" "$STORE" "$SERVER" "$HELPER" "$COMMIT" "$SNAPSHOT" "$DIGEST" "$SCHEMA"; do
     [ -n "$VALUE" ] || { echo "the receipt is incomplete: $TC_RECEIPT" >&2; exit 1; }
   done
   expr "x$DIGEST" : 'x[0-9a-f]\{64\}$' >/dev/null || { echo "the receipt's sha256 is not a sha256: $TC_RECEIPT" >&2; exit 1; }
   expr "x$COMMIT" : 'x[0-9a-f]\{40\}$' >/dev/null || { echo "the receipt's commit is not a commit id: $TC_RECEIPT" >&2; exit 1; }
   expr "x$SCHEMA" : 'x[0-9]\{1,\}$' >/dev/null || { echo "the receipt's schema is not a number: $TC_RECEIPT" >&2; exit 1; }
   for LABEL in "$SERVER" "$HELPER"; do
     expr "x$LABEL" : 'xcom\.tangleclaw\.[A-Za-z0-9.-]\{1,\}$' >/dev/null || { echo "the receipt's job label is not a TangleClaw label: $LABEL" >&2; exit 1; }
   done
   PLIST="$HOME/Library/LaunchAgents/$SERVER.plist"
   JOB="gui/$(id -u)/$SERVER"
   HELPER_JOB="gui/$(id -u)/$HELPER"
   QUARANTINE=$(field restore_quarantine)
   [ -n "$(field restore_begun)" ] && [ -n "$QUARANTINE" ] || { echo "no restore was begun from this receipt: $TC_RECEIPT" >&2; exit 1; }
   [ -z "$(field restore_finished)" ] || { echo "that restore already finished: $TC_RECEIPT" >&2; exit 1; }
   [ -d "$QUARANTINE" ] || { echo "the quarantine the receipt names is not there: $QUARANTINE" >&2; exit 1; }
   grep -Fq "<string>$CHECKOUT</string>" "$PLIST" || { echo "the receipt's checkout is not the one the server job runs from: $PLIST" >&2; exit 1; }
   git -C "$CHECKOUT" cat-file -e "$COMMIT^{commit}"
   [ -s "$SNAPSHOT" ] || { echo "no such snapshot: $SNAPSHOT" >&2; exit 1; }
   SUM=$(shasum -a 256 "$SNAPSHOT")
   [ "${SUM%% *}" = "$DIGEST" ] || { echo "sha256 does not match the receipt: $SNAPSHOT" >&2; exit 1; }
   [ "$(sqlite3 -readonly "$SNAPSHOT" 'PRAGMA integrity_check')" = "ok" ] || { echo "integrity check failed: $SNAPSHOT" >&2; exit 1; }
   [ "$(sqlite3 -readonly "$SNAPSHOT" 'SELECT MAX(version) FROM schema_version')" = "$SCHEMA" ] || { echo "schema does not match the receipt: $SNAPSHOT" >&2; exit 1; }
   command -v lsof >/dev/null || { echo "lsof is needed to prove nothing has the store open" >&2; exit 1; }
   if SEEN=$(launchctl print "$HELPER_JOB" 2>&1); then echo "the bridge helper's job is still loaded, and the previous build has no helper: $HELPER_JOB" >&2; exit 1; fi
   case "$SEEN" in *"Could not find service"*) ;; *) echo "could not prove the helper's job is gone: $HELPER_JOB" >&2; exit 1 ;; esac
   [ ! -e "$HOME/Library/LaunchAgents/$HELPER.plist" ] || { echo "the bridge helper's job file is still installed, so the helper would come back at the next login: $HOME/Library/LaunchAgents/$HELPER.plist" >&2; exit 1; }
   TRIES=0
   while SEEN=$(launchctl print "$JOB" 2>&1); do
     TRIES=$((TRIES + 1))
     [ "$TRIES" -lt 30 ] || { echo "the server job is still loaded: $JOB" >&2; exit 1; }
     sleep 1
   done
   case "$SEEN" in *"Could not find service"*) ;; *) echo "could not prove the server job is gone: $JOB" >&2; exit 1 ;; esac
   for FILE in "$STORE" "$STORE-journal" "$STORE-wal" "$STORE-shm"; do
     [ -e "$FILE" ] || continue
     HELD=$(lsof -Fp -- "$FILE" 2>&1) || true
     [ -z "$HELD" ] || { echo "still open, so nothing was changed: $FILE" >&2; echo "$HELD" >&2; exit 1; }
   done
   if [ -e "$STORE" ]; then
     SUM=$(shasum -a 256 "$STORE")
     if [ "${SUM%% *}" != "$DIGEST" ]; then
       [ ! -e "$QUARANTINE/$(basename "$STORE")" ] || { echo "there is a store here that is not the snapshot, and one already in the quarantine: $STORE" >&2; exit 1; }
       mv "$STORE" "$QUARANTINE/"
     fi
   fi
   for FILE in "$STORE-journal" "$STORE-wal" "$STORE-shm"; do
     [ -e "$FILE" ] || continue
     [ ! -e "$QUARANTINE/$(basename "$FILE")" ] || { echo "already in the quarantine, so it was not moved: $FILE" >&2; exit 1; }
     mv "$FILE" "$QUARANTINE/"
   done
   if [ ! -e "$STORE" ]; then
     INCOMING="$STORE.incoming.$$"
     cp "$SNAPSHOT" "$INCOMING"
     chmod 600 "$INCOMING"
     SUM=$(shasum -a 256 "$INCOMING")
     [ "${SUM%% *}" = "$DIGEST" ] || { echo "the copy does not match the receipt: $INCOMING" >&2; exit 1; }
     mv "$INCOMING" "$STORE"
   fi
   HEAD_NOW=$(git -C "$CHECKOUT" rev-parse HEAD)
   [ "$HEAD_NOW" = "$COMMIT" ] || git -C "$CHECKOUT" checkout --detach "$COMMIT"
   launchctl bootstrap "gui/$(id -u)" "$PLIST"
   printf '%s\n' "restore_finished=$(date -u +%Y%m%dT%H%M%SZ)" >> "$TC_RECEIPT"
   echo "restored: $COMMIT with $SNAPSHOT"
   )
   ```

   → Expected: a last line beginning `restored:`, and the dashboard loads on the previous build.
   → "no restore was begun from this receipt": step 2 did not get that far. Paste step 2's block.
   → "that restore already finished": there is nothing left to do.
   → Any refusal of step 2's that it repeats means the same thing here.

## Done when

The dashboard loads, and the last line of the receipt begins `restore_finished=`. The receipt's
`restore_quarantine=` line names the directory that holds the v5.31 store.

## If this doesn't work

The server is stopped and the v5.31 store is whole, either where it was or in the directory the
receipt's `restore_quarantine=` line names. Delete nothing. A file named
`tangleclaw.db.incoming.<n>` beside the store is an unfinished copy and is never the active
store. A directory named `probe.<stamp>` beside the receipt is a copy the block made to read the
store's schema and did not get to remove; it is never read again. Tell the Architect.

> 🚧 **UNVERIFIED** — both blocks were rehearsed on a throwaway install with its own job
> labels, under `sh` and `zsh`, against a real launchd and a real SQLite store. They have not
> been run against this install · that the previous build starts under the launchd job
> v5.31.0 installed has not been seen. Going back to v5.31.0 afterwards (moving the quarantined
> files back, with the server stopped, and checking v5.31.0 out again) is not written as
> commands because nobody has run it.
