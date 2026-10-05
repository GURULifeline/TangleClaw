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
   `tc_helper uninstall-launchd`
   `tc_helper status`
   → Expected: `helper: not running`. In Discord the bot shows as offline within about a minute.
   An error from `bootout` because the job was never loaded is fine.
   → `tc_helper` is not a command in this terminal, or it answers naming `TC_RECEIPT`: the first
   line has already stopped the helper. Enter `unalias -a` on a line of its own, set `TC_RECEIPT`
   to the cutover receipt, paste the first block of
   [the checked-commands step](activate-the-operator-bridge.md#checked-commands) of the
   activation runbook, and run those two again.
   → `tc_helper` refuses for another reason ("the receipt has no to_commit line", "the checkout
   is not at the commit the receipt records"): the activation did not get far enough to record
   the build, or the checkout has moved since. The first line has already stopped the helper.
   Remove its job file yourself, so that it does not start again at the next login:
   `rm "$HOME/Library/LaunchAgents/com.tangleclaw.bridge-helper.plist"`
   then `launchctl print gui/$(id -u)/com.tangleclaw.bridge-helper`
   → Expected: an answer beginning `Could not find service`.

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

8. Stop here. The bridge is rolled back, on v5.31.0, with its store as it is. Putting back the
   previous build and the store from before the update is a different procedure, for a different
   failure: [Put back the build from before the operator bridge](put-back-the-build-before-the-operator-bridge.md).
   It is never part of rolling the bridge back.

## Done when

`tc_helper status` says `helper: not running`. `tc bridge routes`, run by the Master,
prints `No routes in those states.` The panel says "Nothing is queued without a route." A
message the Operator writes in the channel gets no ✅ and no reply.

## If this doesn't work

The helper cannot post without the bot's permission in the channel: the Operator removing the bot
from the channel in Discord stops it whatever else is true. Then tell the Architect.
