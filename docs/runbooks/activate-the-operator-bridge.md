# Activate the operator bridge

Tier 3: it changes who may post to the operator's Discord and replaces an operator rule. Run by
the builder who owns #2031, with the Architect; the steps marked **Operator** need the Operator
signed in.

## When to use this

The cumulative Phase 2 to 5 pull request for #2031 has merged by a true merge commit, exact-head
CI is green, and the Reviewer2 security review is recorded. The bridge is still disabled.

## When NOT to use this

Any of those is missing, or the server is not running the merged commit. Stop. Until the rule is
replaced in the step that says so, and after any roll back, Rule #145 and [the interim procedure](../discord-operator-notifications.md) stay in force.

## Prerequisites

- The Operator, signed in to the dashboard with an account session. Every step marked
  **Operator** is done in the dashboard's global settings, section **Operator bridge (Discord)**.
  Not with curl, and not from the browser's developer tools.
- The Project Master running, as a switchboard participant.
- The Discord bot token in the Keychain: service `tangleclaw-discord-helper`, account
  `discord-bot-token`. Never type it into a command line.
- A second Discord account that is not the Operator's, for step 8.

## Steps

Run commands from the TangleClaw checkout the service runs from. If any step's expected result
does not appear, go to [Roll the operator bridge back](roll-back-the-operator-bridge.md) and tell
the Architect.

1. Back up the store:
   `sqlite3 ~/.tangleclaw/tangleclaw.db ".backup '$HOME/.tangleclaw/tangleclaw.pre-bridge.db'"`
   → Expected: the file exists and is not empty.
   > 🚧 **UNVERIFIED** — this backup command has not been run on this install · run it once and
   > open the copy with `sqlite3 <copy> .tables` before relying on it.

2. Restart the server onto the merged build:
   `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server`
   then `sqlite3 ~/.tangleclaw/tangleclaw.db 'SELECT MAX(version) FROM schema_version'`
   → Expected: `54`, and `GET /api/health` answers.
   → If the server does not come up: `~/.tangleclaw/logs/server.err.log` names each bridge object
   that failed its shape check. Roll back.

3. **Operator:** in the panel, enter the three Discord ids and press **Set the allowlist**; then
   press **Create the helper token**. Leave the token on screen for step 4.
   → Expected: the Allowlist line shows the three ids, and the token appears once under
   "The helper token, shown once."
   → The panel says "Sign in to see and change it": the browser has no account session. Sign in.
   > 🚧 **UNVERIFIED** — the panel is proven by tests against the real operator routes. No person
   > has yet used it in a browser on this install · the first activation is that check; if a
   > control does not do what this step says, stop and roll back.

4. Store the helper token, then configure the helper. Run the first command, press **Copy** in
   the panel, paste at the command's prompt, then press **I have stored it**:
   `bin/tc-bridge-helper set-secret helper`
   `bin/tc-bridge-helper configure --base-url <TANGLECLAW_API> --author <id> --guild <id> --channel <id>`
   → Expected: `Stored the helper token in the Keychain.` and `Config written.`

5. `bin/tc-bridge-helper preflight`
   → Expected: exit 0; every line `ok` except `bridge-enabled` and `discord-post`, which say
   `unproven`.
   → If any line says `FAIL`: fix what it names and run it again. Do not go on.

5a. The Master runs `tc bridge status` in its own pane.
   → Expected: `Operator bridge: DISABLED`, then `You are Master generation <n>`.
   → Any refusal: there is no live verified Master. Do not enable. Relaunch the Master, then repeat.
   Why: the enable switch checks the Master's setting, not that a Master is running.

6. **Operator:** press **Enable the bridge** and confirm.
   → Expected: the Bridge line says **enabled**, and Project Master shows `listener listening`.
   → "Not done: The Project Master is not a switchboard participant": turn on the Master's Medusa
   setting, then repeat.

7. Start the helper: `bin/tc-bridge-helper install-launchd`, then `bin/tc-bridge-helper status`
   → Expected: `helper: running`, `gateway: ready`, `held: nothing`. `status` shows what the
   helper last wrote down, once a pass: if it says anything else (`connecting`, `reconnecting`,
   `no snapshot yet`, `helper: not running`), run it again after 30 seconds, for up to five
   minutes, before treating it as failed. In Discord the bot shows as an online
   member of the server: the online count is one more than before the helper started (from 1
   to 2 when only the Operator is online).
   Online proves the helper's Gateway connection only. The bridge is operational when it is
   enabled (step 6), the Master is verified (`tc bridge status`, run by the Master in its own
   pane, answers) and the Gateway is `ready`.
   → `gateway: fatal (close code 4014)`: turn on Message Content Intent for the bot, then
   `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.bridge-helper`.

8. Controlled inbound. The Operator writes one message in the channel; then the second account
   writes one.
   → Expected: a ✅ on the Operator's message and one new route in `tc bridge routes` (run by the
   Master). Nothing at all for the second account's message: no reaction, no route.

9. Controlled outbound. A project session offers a milestone with `tc candidate submit`; the Master
   approves it with `tc bridge approve <candidate-id> --version <n>`.
   → Expected: one post in the channel headed `Project Master, from <project name>`;
   `tc bridge blocked` lists nothing.
   → `tc bridge status` shows `CONFIGURATION CIRCUIT OPEN`: the bot cannot post there. Fix its
   permissions, then `tc bridge reset --requeue`.

10. Read the replacement text for Rule #145 that the Architect has approved.
    → Expected: it has the clause that lets the Architect alone post by the direct route while
    the bridge is rolled back. If it does not, stop: after this step a rollback would leave
    nobody allowed to reach the Operator.
    **Operator:** replace Rule #145 with that text. Then,
    under "Telling sessions of tc candidate", press **Switch it on** and confirm.
    → Expected: that line says `on`.

10a. Launch one project session, then **Operator:** press **Refresh** in the panel.
    → Expected: the line still says only `on`, and `tc candidate` is in the verb list of that
    session's opening context.
    → If it adds "a session of project <id> was not told": that session's section ran over its
    cap and it was not told of `tc candidate`. The switch is on and nothing is posted wrongly.
    Tell the Architect the two numbers it shows, and go on: sessions can still be told by hand.

11. Final acceptance. The Architect sends the final milestone through the Master. The Operator
    replies to that exact Discord message. The Master runs `tc bridge read <route-id>` on the new
    route and answers with `tc bridge answer`.
    → Expected: `read` shows `answers posted milestone <candidate-id>`; the answer appears in the
    same Discord conversation.

## Done when

Step 11's answer is in Discord, `tc bridge status` (run by the Master in its own pane) shows the
bridge enabled with no circuit open,
and `bin/tc-bridge-helper status` shows `held: nothing`.

## If this doesn't work

Roll back with [Roll the operator bridge back](roll-back-the-operator-bridge.md); the Architect's
direct posting under Rule #145 is the path again. Wake the Operator only for a missing credential
or permission, or a failed step that needs a choice.
