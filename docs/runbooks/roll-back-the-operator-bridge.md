# Roll the operator bridge back

Tier 3: it stops the only automated path to the operator's Discord. Run by the builder who owns
#2031 or the Architect; the steps marked **Operator** need the Operator signed in. Step 2 does
not, and by itself stops everything reaching Discord.

## When to use this

A step of [Activate the operator bridge](activate-the-operator-bridge.md) did not give its
expected result, or the live bridge is posting something it should not, posting twice, or
accepting messages from anyone but the Operator.

## Steps

Do them in order. Each one alone makes things safer, so do not wait on one to start the next.

1. **Operator:** disable the bridge (`POST /api/bridge/operator/disable`).
   → Expected: `200`, `"enabled": false`. From now the bridge refuses the helper, every session's
   candidate and every Master write that could lead to a post with `409 BRIDGE_DISABLED`. The
   Master can still close a route, withdraw what is queued, and acknowledge or reset the circuit.

1a. **Operator:** switch the candidate primer off
   (`POST /api/bridge/operator/candidate-primer` with `{"primed": false}`).
   → Expected: `200`, `"candidatesPrimed": false`.
   Why: disabling the bridge leaves this switch as it was. Left on, enabling the bridge again
   would tell every newly launched session of `tc candidate` before the controlled checks.
   → If the Operator cannot be reached: go to step 2 now. It stops everything reaching Discord.

2. Stop the helper and remove its job:
   `launchctl bootout gui/$(id -u)/com.tangleclaw.bridge-helper`
   `bin/tc-bridge-helper uninstall-launchd`
   then `bin/tc-bridge-helper status`
   → Expected: `helper: not running`. In Discord the bot shows as offline within about a minute.

3. **Operator:** revoke the helper token (`DELETE /api/bridge/operator/helper-token`).
   → Expected: `200`. A helper started by mistake now gets `401 HELPER_TOKEN_REQUIRED`.

4. If Rule #145 had been replaced: the **Operator** restores its text. Tell the Architect, who
   posts directly again under it.

5. Only if the server itself will not start on the merged build: stop it, restore the store, and
   start the previous build.
   `launchctl bootout gui/$(id -u)/com.tangleclaw.server`
   `cp ~/.tangleclaw/tangleclaw.pre-bridge.db ~/.tangleclaw/tangleclaw.db`
   > 🚧 **UNVERIFIED** — restoring the store and returning to the previous build have not been
   > rehearsed on this install · confirm the previous build's commit and how it is checked out
   > with the Architect before doing this.

## Done when

`bin/tc-bridge-helper status` says `helper: not running`, and a message the Operator writes in
the channel gets no ✅.

## If this doesn't work

The helper cannot post without the bot's permission in the channel: the Operator removing the bot
from the channel in Discord stops it whatever else is true. Then tell the Architect.
