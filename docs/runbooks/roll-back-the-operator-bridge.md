# Roll the operator bridge back

Tier 3: it stops the only automated path to the operator's Discord. Run by the release executor
or the Architect. The steps marked **Operator** need the Operator signed in to the dashboard,
and are done in global settings, section **Operator bridge (Discord)**. Step 3 needs no
Operator, and by itself stops everything reaching Discord.

## When to use this

A step of [Activate the operator bridge](activate-the-operator-bridge.md) did not give its
expected result, or the live bridge is posting something it should not, posting twice, or
accepting messages from anyone but the Operator.

## Steps

Do them in order. Each one alone makes things safer, so do not wait on one to start the next.
A step is already done only when its Expected line is already true on a signed-in panel: then go
on. A panel that says "Sign in to see and change it" shows nothing either way: sign in. If the
server is down, do steps 3 and 7. Step 8 is not part of rolling the bridge back: it has its own
conditions.

1. **Operator:** press **Disable the bridge**. It asks nothing and acts at once.
   → Expected: the Bridge line says **disabled**. If it already does, and the buttons beside it
   are **Enable the bridge** and **Refresh**, go on.
   From now the bridge takes no new message, hands the helper nothing, and refuses every Master
   write that could lead to a post. Until steps 3 and 4 are done, a post the helper was already
   making can still land, and the helper still answers the Operator in Discord with "Not
   delivered: the TangleClaw operator bridge is turned off."
   → If the Operator cannot be reached: go to step 3 now.

2. **Operator:** under "Telling sessions of tc candidate", press **Switch it off**.
   → Expected: the line "Now" says `off`. If it already says `off`, go on.
   Why: disabling the bridge leaves this switch as it was. Left on, enabling the bridge again
   would tell every newly launched session of `tc candidate` before the controlled checks.

3. Stop the helper and remove its job:
   `launchctl bootout gui/$(id -u)/com.tangleclaw.bridge-helper`
   `"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" uninstall-launchd`
   `"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" status`
   → Expected: `helper: not running`. In Discord the bot shows as offline within about a minute.
   An error from `bootout` because the job was never loaded is fine.
   → The second or third line answers naming `TC_CHECKOUT`: the first line has already stopped
   the helper. Set `TC_CHECKOUT` to the checkout the service runs from and run those two again.

4. **Operator:** under Helper token, press **Revoke it** and confirm. The button is off until
   step 1 is done.
   → Expected: the line "Now" says **none**. If there is no **Revoke it** button, there is no
   token: go on.
   Why now: revoking the token ends every lease the helper held, at once. After this no route's
   close can be refused for an item in the helper's hands.

5. **Master:** close every route still open. In its own pane: `tc bridge routes`, then for each
   one `tc bridge close <route-id> --version <n>`.
   → Expected: `tc bridge routes` prints `No routes in those states.`
   Why: a route still waiting on a project keeps its message to that project open, and with the
   bridge off nothing will ever answer the operator for it. Closing a route ends that message,
   clears its text and withdraws what was released for it. Answering is refused while the
   bridge is disabled, so close.
   → The Master declines, saying its rules forbid it: its stored first rule is the old one. Do
   [the Master rule step](activate-the-operator-bridge.md#master-rule) and then
   [the Master relaunch step](activate-the-operator-bridge.md#master-relaunch) of the activation
   runbook, then repeat this step.
   Nothing reaches Discord meanwhile: steps 3 and 4 saw to that.
   → `refused [OUTBOUND_IN_FLIGHT]`: step 4 has not been done. Do it, then close: with the token
   revoked there is nothing to wait for.
   → Only if the Operator cannot be reached, so the token cannot be revoked: run the close again
   once the helper has been stopped for longer than a lease lasts, which is 120 seconds.

6. **Operator:** under "Queued with no open route", press **Withdraw** on every row and confirm
   each.
   → Expected: "Nothing is queued without a route."
   Why: closing routes clears only what belonged to them. A candidate nobody decided, an
   approved milestone not yet posted, a server notice: these belong to no route, wait through
   a disabled bridge, and would be posted when it is next enabled.

7. Tell the Architect the bridge is rolled back. No rule is edited. Before the Discord rule was
   replaced, Rule #145 is in force as it was. After, the new rule's own second paragraph
   applies: the Architect alone posts milestones and operator-action-required notices by the
   former direct route, until the bridge is enabled again.
   If the steps above gave their expected results, the rollback is complete: stay on v5.31.0 and
   do not restore the database.

8. <a id="restore-the-previous-build"></a>**Emergency only: put back the previous build and its
   store.** This is not a step of rolling the bridge back, and it is never used because the
   bridge misbehaves: steps 1 to 7 deal with that, on v5.31.0. Use it only when v5.31.0 itself
   cannot start or stay healthy, and the previous build has to run.

   It is a rollback in time. The active TangleClaw store returns to the moment of
   [the snapshot](activate-the-operator-bridge.md#snapshot). Everything written after that is
   absent from the active store: sessions, workload and Medusa state, audit rows, the bridge's
   settings, routes and items, and the rule and configuration changes made during activation.
   The v5.31 store and its sidecar files are moved into a quarantine directory and kept, byte for
   byte, but nothing merges them back.

   **Operator:** say that you agree to return the store to the snapshot and to lose what was
   written since. **Architect:** be present. Without both, do not run it.

   **Release executor:** in a terminal, set `TC_CHECKOUT` to the checkout the service runs
   from. Set `TC_COMMIT`, `TC_SNAPSHOT`, `TC_SNAPSHOT_SHA256` and `TC_SNAPSHOT_SCHEMA` to the
   `commit:`, `snapshot:`, `sha256:` and `schema:` lines of the cutover receipt, and nothing
   else. Once the Operator has agreed, set `TC_OPERATOR_CONFIRMED=return-to-snapshot`. Then paste
   this as it is. The parentheses matter: the first thing that fails stops the block, and
   nothing after it runs.

   ```sh
   (
   set -eu
   umask 077
   : "${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}"
   : "${TC_COMMIT:?set TC_COMMIT to the commit: line of the cutover receipt}"
   : "${TC_SNAPSHOT:?set TC_SNAPSHOT to the snapshot: line of the cutover receipt}"
   : "${TC_SNAPSHOT_SHA256:?set TC_SNAPSHOT_SHA256 to the sha256: line of the cutover receipt}"
   : "${TC_SNAPSHOT_SCHEMA:?set TC_SNAPSHOT_SCHEMA to the schema: line of the cutover receipt}"
   [ "${TC_OPERATOR_CONFIRMED:-}" = "return-to-snapshot" ] || { echo "not confirmed: the Operator has not agreed to return the store to the snapshot" >&2; exit 1; }
   STORE="${TC_STORE:-$HOME/.tangleclaw/tangleclaw.db}"
   PLIST="$HOME/Library/LaunchAgents/com.tangleclaw.server.plist"
   JOB="gui/$(id -u)/com.tangleclaw.server"
   grep -Fq "<string>$TC_CHECKOUT</string>" "$PLIST" || { echo "TC_CHECKOUT is not the checkout the server job runs from: $PLIST" >&2; exit 1; }
   git -C "$TC_CHECKOUT" cat-file -e "$TC_COMMIT^{commit}"
   [ -s "$TC_SNAPSHOT" ] || { echo "no such snapshot: $TC_SNAPSHOT" >&2; exit 1; }
   SUM=$(shasum -a 256 "$TC_SNAPSHOT")
   [ "${SUM%% *}" = "$TC_SNAPSHOT_SHA256" ] || { echo "sha256 does not match the receipt: $TC_SNAPSHOT" >&2; exit 1; }
   [ "$(sqlite3 -readonly "$TC_SNAPSHOT" 'PRAGMA integrity_check')" = "ok" ] || { echo "integrity check failed: $TC_SNAPSHOT" >&2; exit 1; }
   [ "$(sqlite3 -readonly "$TC_SNAPSHOT" 'SELECT MAX(version) FROM schema_version')" = "$TC_SNAPSHOT_SCHEMA" ] || { echo "schema does not match the receipt: $TC_SNAPSHOT" >&2; exit 1; }
   command -v lsof >/dev/null || { echo "lsof is needed to prove nothing has the store open" >&2; exit 1; }
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
   git -C "$TC_CHECKOUT" checkout --detach "$TC_COMMIT"
   QUARANTINE="$(dirname "$STORE")/quarantine-v5.31.${TC_RESTORE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
   mkdir "$QUARANTINE"
   echo "quarantine: $QUARANTINE"
   for FILE in "$STORE" "$STORE-journal" "$STORE-wal" "$STORE-shm"; do
     [ -e "$FILE" ] || continue
     mv "$FILE" "$QUARANTINE/"
   done
   INCOMING="$STORE.incoming.$$"
   cp "$TC_SNAPSHOT" "$INCOMING"
   chmod 600 "$INCOMING"
   SUM=$(shasum -a 256 "$INCOMING")
   [ "${SUM%% *}" = "$TC_SNAPSHOT_SHA256" ] || { echo "the copy does not match the receipt: $INCOMING" >&2; exit 1; }
   mv "$INCOMING" "$STORE"
   launchctl bootstrap "gui/$(id -u)" "$PLIST"
   echo "restored: $TC_COMMIT with $TC_SNAPSHOT"
   )
   ```

   → Expected: a line beginning `quarantine:`, a last line beginning `restored:`, the dashboard
   loads, and
   `sqlite3 ~/.tangleclaw/tangleclaw.db 'SELECT MAX(version) FROM schema_version'` prints the
   `schema:` line of the receipt. Write the `quarantine:` line into the cutover receipt.
   → It stops naming a `TC_` variable, or saying "not confirmed", "not the checkout", "no such
   snapshot", "does not match the receipt", "integrity check failed" or "lsof is needed", or with
   git not knowing the commit: nothing has been stopped or changed. Put right what it names and
   paste it again.
   → It stops saying "still loaded", "could not prove the server job is gone" or "still open":
   the store is untouched. A line beginning `p` is the id of a process that has the file open.
   Stop nothing by name or pattern. Tell the Architect the ids and paths it printed.
   → It stops at `checkout`: the server is stopped, the store is untouched, and git says why.
   Tell the Architect before doing anything else.
   → It stops after the `quarantine:` line: the server is stopped, and the v5.31 store is whole
   in that directory. Put right what it names and paste it again. Each paste makes a new
   quarantine directory and overwrites none. A file named `tangleclaw.db.incoming.<n>` left
   beside the store is an unfinished copy and is never the active store.
   > 🚧 **UNVERIFIED** — this restore has not been rehearsed on this install: that the previous
   > build starts under the launchd job v5.31.0 installed has not been seen · do it with the
   > Architect watching. To go back to v5.31.0 instead, the Architect has the files in the first
   > quarantine directory moved back beside where the store was, with the server stopped, and
   > v5.31.0 checked out again: that path is not written as commands because nobody has run it.
   The previous build is given the snapshot, never the v54 store: it does not know v54.

## Done when

`"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" status`
says `helper: not running`. `tc bridge routes`, run by the Master,
prints `No routes in those states.` The panel says "Nothing is queued without a route." A
message the Operator writes in the channel gets no ✅ and no reply.

## If this doesn't work

The helper cannot post without the bot's permission in the channel: the Operator removing the bot
from the channel in Discord stops it whatever else is true. Then tell the Architect.
