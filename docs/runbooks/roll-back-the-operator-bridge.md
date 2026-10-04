# Roll the operator bridge back

Tier 3: it stops the only automated path to the operator's Discord. Run by the builder who owns
#2031 or the Architect; the steps marked **Operator** need the Operator signed in, and are done
in the dashboard's global settings, section **Operator bridge (Discord)**. Step 2 needs no
Operator, and by itself stops everything reaching Discord.

## When to use this

A step of [Activate the operator bridge](activate-the-operator-bridge.md) did not give its
expected result, or the live bridge is posting something it should not, posting twice, or
accepting messages from anyone but the Operator.

## Steps

Do them in order. Each one alone makes things safer, so do not wait on one to start the next.

1. **Operator:** press **Disable the bridge**. It asks nothing and acts at once.
   → Expected: the Bridge line says **disabled**. From now the bridge refuses the helper, every session's
   candidate and every Master write that could lead to a post with `409 BRIDGE_DISABLED`. The
   Master can still close a route, withdraw what is queued, and acknowledge or reset the circuit.

1a. **Operator:** under "Telling sessions of tc candidate", press **Switch it off**.
   → Expected: that line says `off`. (Before this, with the bridge disabled, it says the switch is
   set on and not in effect.)
   Why: disabling the bridge leaves this switch as it was. Left on, enabling the bridge again
   would tell every newly launched session of `tc candidate` before the controlled checks.
   → If the Operator cannot be reached: go to step 2 now. It stops everything reaching Discord.

1b. The Master closes every route still open: `tc bridge routes`, then for each one
   `tc bridge close <route-id> --version <n>`.
   → Expected: `tc bridge routes` lists nothing.
   Why: a route still waiting on a project keeps its message to that project open, and with the
   bridge off nothing will ever answer the operator for it. Closing the route ends that message
   at once and clears its text. Answering is refused while the bridge is disabled, so close.
   → `409 OUTBOUND_IN_FLIGHT` on a close: the helper holds something of that route under a
   lease, and may be posting it at this moment. Do step 2 now, or wait two minutes for the lease
   to lapse; then close that route.
   → If the Master cannot be reached: go on. Close them when it can.

2. Stop the helper and remove its job:
   `launchctl bootout gui/$(id -u)/com.tangleclaw.bridge-helper`
   `bin/tc-bridge-helper uninstall-launchd`
   then `bin/tc-bridge-helper status`
   → Expected: `helper: not running`. In Discord the bot shows as offline within about a minute.

3. **Operator:** press **Revoke it** under Helper token, and confirm. The button is off until
   step 1 is done: the panel revokes only a disabled bridge's token.
   → Expected: the Helper token line says **none**. A helper started by mistake now gets
   `401 HELPER_TOKEN_REQUIRED`.

4. Tell the Architect the bridge is rolled back. No rule is edited. If Rule #145 was never
   replaced, it is still in force as it was. If it was replaced, the replacement itself lets the
   Architect, and nobody else, post milestones and operator-needed notices by the direct route
   until the bridge is enabled again.

5. Only if the server itself will not start on the merged build: stop it, restore the store, and
   start the previous build.
   `launchctl bootout gui/$(id -u)/com.tangleclaw.server`
   `cp ~/.tangleclaw/tangleclaw.pre-bridge.db ~/.tangleclaw/tangleclaw.db`
   > 🚧 **UNVERIFIED** — restoring the store and returning to the previous build have not been
   > rehearsed on this install · confirm the previous build's commit and how it is checked out
   > with the Architect before doing this.
   The previous build is given the restored store, never the v54 one: it does not know v54.

## Done when

`bin/tc-bridge-helper status` says `helper: not running`, and a message the Operator writes in
the channel gets no ✅.

## If this doesn't work

The helper cannot post without the bot's permission in the channel: the Operator removing the bot
from the channel in Discord stops it whatever else is true. Then tell the Architect.
