# The operator bridge

The operator bridge lets the operator reach the fleet from a chat application and get answers
back in the same conversation. [ADR 0023](adr/0023-master-mediated-operator-bridge.md) records
the design: a durable gateway on the server carries each message, the Project Master session
decides where it goes and what the operator reads, and neither is authority.

This page describes what is built. The interim Discord procedure that is in force until cutover
is in [discord-operator-notifications.md](discord-operator-notifications.md).

## Status

| Part | State |
|---|---|
| Storage (schema v52, reshaped by v53) | Built |
| The Project Master's bridge credential | Built |
| Gateway: accept, resolve, dispatch, hold the reply, release | Built |
| `tc bridge` for the Project Master, routing and answering included | Built |
| The helper's three routes and its scoped token | Built |
| The operator's policy routes: enable, allowlist, token, aliases, pins | Built |
| The candidate lane: a session offers, the Master decides | Built |
| The three typed server notifications | Built |
| Discord helper | Not built |
| A dashboard page for the operator's policy | Not built; the routes exist |
| Cutover | Not started; Rule #145 is unchanged and in force |

The bridge is **disabled by default**. Only the operator can enable it, signed in with an
account session, and only after setting the allowlist and creating the helper token. With no
helper built, enabling it connects to nothing: no chat message can arrive and nothing posts to
a chat application.

### What ADR 0023 still requires

ADR 0023 is accepted for architecture only. Its acceptance does not authorise merging an
implementation, assigns no schema number and does not activate cutover.

- **Schema numbers.** 52 and 53 were each the next free number on `main` when taken, under the
  Architect's rulings of 2026-10-04.
- **Merge.** Each change merges only after an exact-head independent security review, and is
  never set to merge automatically.
- **Cutover.** Not part of any change so far. It needs the security review, a live round trip
  and the operator's approval to replace Rule #145. Enabling the bridge on a live install is
  part of cutover, not something to do because the switch exists.

## How a message travels

```
inbound    helper ──▶ gateway ──▶ destination session        (or the Master itself)
outbound   destination session ──▶ gateway (held) ──▶ Master releases ──▶ gateway ──▶ helper
```

1. **The helper hands over a message.** The gateway refuses it unless the bridge is enabled and
   the message is from the one allowlisted author, space and channel. A refused message is
   counted and none of it is kept.
2. **The gateway stores it as a route**, keyed on the chat's own message id. A replay of the
   same message returns the same route. The same id with different text, or from a different
   place, is refused.
3. **The gateway resolves the destination mechanically**, in this order:
   1. a leading `@name`;
   2. the route of the message this one replies to;
   3. a pin on the conversation: the operator's for that conversation, then the operator's for
      every conversation, then the Master's;
   4. the default, which is the Project Master itself.
4. **A project destination gets a tracked Medusa message** from the gateway, reply required,
   normal priority. Its first line says it is operator conversation and approves nothing. The
   gateway records exactly who it was sent to: the project, workspace, session and launch.
5. **The reply is held.** The gateway accepts a reply only when the sender's own exchange record
   shows a verified launch answering exactly that message from exactly that project, workspace,
   session and launch. Anything else is dropped and counted. A held reply is posted nowhere.
6. **The Master releases an answer**: the held reply unchanged, or its own words. Only then
   does an item exist for the helper.
7. **The helper posts it and acknowledges** with the chat's id for the post. The text is then
   dropped, the route is closed and every body held for it is cleared.

When the Master is the destination there is no Medusa round trip: the route waits, the Master is
told, and it answers with `tc bridge answer`.

### Telling the Master

The gateway tells the Master through its Medusa listener, with a system notice the existing wake
monitor turns into a nudge. It tells it once for each state a route reaches that needs it: a
route to decide, a route that is the Master's to answer, a reply held for release, and again if
a route is handed back after a failure. A notice that could not be sent is not recorded as
given, so the next pass sends it.

**If the Master's Medusa listener is off, nothing nudges it.** The route still waits, the status
notice still goes to the operator and the gap is logged, but the Master only finds the route by
running `tc bridge routes`. The Architect ruled on 2026-10-04 that this must be closed, failing
closed, before cutover; it is not solved here.

### Sending exactly once

A message is sent to its destination once. One route is advanced by one caller at a time, and
before a message is sent the gateway looks for an exchange already made for that attempt. What
it finds decides what happens:

| What is found | What happens |
|---|---|
| No exchange, and the send is refused before the Hub is called | Nothing was sent. The route goes back to the Master to route again. |
| An exchange with the Hub's message id | The message is on the Hub. It is recorded and the route is `routed`. |
| The Hub answered with a message id, but the exchange row could not take it | The id is kept in the audit and the gateway binds the row itself, on this pass and every later one. Until it binds, the route waits as unconfirmed; once it does, the route is `routed`. A route is never `routed` on an exchange without its Hub id, because the target's reply is found through that id. |
| The Hub refused the message (`undeliverable`) | Proven undelivered. The route goes back to the Master. |
| Anything else: still pending, or the outcome unknown | The route stays where it is. After two minutes it is marked `send-unconfirmed`, the operator gets one notice saying so, and the Master is told. |

**An unconfirmed send is never sent again**, by a later pass, after a restart, or by the Master
routing it: the request id of an attempt changes only when the attempt is recorded as sent or
proven undelivered, so the existing exchange is always found first. A recipient session that
ends does not prove an unconfirmed send was undelivered, and does not reopen it. The Master can answer an
unconfirmed route in its own words or close it. Only a proven failure reopens routing.

### Addresses

An address is a leading `@name` that names **exactly one** destination:

- `@master`, which always means the Project Master and cannot be an alias;
- an operator alias;
- a project's exact name, without regard to case;
- a project's id.

An `@name` that matches nothing, or more than one destination, is never guessed at. The route
waits for the Master (`awaiting-master`). A chat application's own mention syntax, such as
`<@123>`, is not an address, and neither is an `@name` in the middle of a sentence.

A destination, once fixed on a route, does not move: a later change to pins, aliases or the
default does not redirect a message that is still waiting.

### When something does not arrive

- **The target has no live session, or the send is refused before it leaves:** the route goes
  back to the Master to route again, and the operator gets one failure notice.
- **The exchange later fails** (undeliverable, recipient retired): the same.
- **Nobody knows whether it arrived:** see "Sending exactly once". It is not sent again.
- **The Master is not running:** the gateway starts it, at most once per backoff window (15
  seconds, doubling to 10 minutes). If it cannot, the route is queued. Nothing falls back to
  the Architect.
- **A different session of the target project answers,** or the target was relaunched: that is
  not a reply. Reaching another session takes the Master routing the message again.

### The one status notice

A route gets at most one `status` item in its life: that the Master is unavailable, or, after
five minutes without a final answer, that the message is still waiting. Whichever comes first
is the only one. Its text is one of two fixed sentences the server wrote; a status item cannot
carry anything anybody typed. The Medusa message itself is normal priority, so the delivery
watchdog never raises it to its escalation or operator rungs.

## The Project Master's credential

The Project Master has no project and no session row, so nothing TangleClaw records at a
project launch can prove a request is the Master's. The bridge gives it a credential of its own.

- **Minted at launch.** Creating the Master session mints a credential and records it as the
  next *generation*. Every earlier generation is revoked in the same step.
- **Hash only.** The server keeps the SHA-256 of the credential and never the value.
- **One purpose.** It authorises the `/api/bridge/master/*` routes and nothing else. The Master's
  role header and launch id do not stand in for it, and it grants no other access.
- **Revoked when the Master ends.** Killing the Master revokes it. After a server restart, a
  handoff the restart interrupted is revoked, and an active credential is revoked when tmux
  reports no Master. If tmux does not answer, a running Master keeps its credential.
- **A Master that was already running has none.** It must be relaunched to hold one.

### How it reaches the pane

The credential must reach the Master's environment without being an argument to any command.
`tmux new-session -e` and `tmux set-environment` both fail that: the first puts the value in
argv, and both leave it in the tmux session environment, where `tmux show-environment` returns
it. So:

1. The server makes a FIFO with mode 0600 in `bridge-handoff/` under TangleClaw's state
   directory (mode 0700). That directory is beside the Master's home, not inside it.
2. The pane's launch command names the FIFO's path. It runs `bin/tc-bridge-receive`, which reads
   one line into `TANGLECLAW_BRIDGE_CREDENTIAL` and removes the FIFO.
3. The server writes the credential once the pane has the FIFO open, then removes the FIFO too.

Both ends are bounded. If the pane never opens the FIFO, the server gives up, revokes that
generation and removes the FIFO. If the server never writes, the pane stops waiting and launches
without the credential. The Master still runs; it lacks the bridge capability until relaunched.

### What the credential does not protect against

These are the host's current trust boundary. The credential does not defeat them, and no
isolation between sessions running as the same user is claimed.

- **Another process running as the same user** can read a process's environment, and so can
  read the credential.
- **The Master's own shell** can print the variable. The Master's generated identity tells it
  not to; nothing structural prevents it.

Whether this boundary is acceptable for cutover is decided by the security review that precedes
cutover. If it is not, the bridge stays disabled and the interim procedure stays in force.

## `tc bridge`

For the Project Master only. `bin/tc` forwards the credential from the pane's environment to
the bridge's own routes and nowhere else, so it is never typed.

| Command | Does |
|---|---|
| `tc bridge status` | Says whether the bridge is enabled and which generation is asking. Answers while disabled. |
| `tc bridge routes [--state <state>]...` | Lists routes, oldest first, without bodies. Open states by default. |
| `tc bridge read <route-id>` | Shows one route with the text still held for it. |
| `tc bridge route <route-id> --version <n> --to <dest>` | Names the destination of a route that is waiting for the Master. The gateway then sends it. |
| `tc bridge answer <route-id> --version <n> --text "<text>"` | Answers the operator in the Master's own words. `--text-file <file>` reads the answer from a file. |
| `tc bridge release <route-id> --version <n>` | Sends on, unchanged, the reply the gateway is holding. |
| `tc bridge pin <route-id> --version <n> --to <dest>` | Pins the route's conversation to a destination. Conversation-scoped only. |
| `tc bridge close <route-id> --version <n>` | Closes a route and clears its text. |

`<dest>` is `master`, a project's exact name or a project's id.

The Master is read-only everywhere else. Its first baseline rule now carries one narrow
exception: it may record routing decisions with `tc bridge`, and with nothing else, when it holds
the live credential, the bridge is enabled, and the write names a request id and the route
version it read. The rule says this is routing, not authority.

- The baseline rules seed a fresh install and are what "Restore defaults" recovers. An install
  whose Master rules already exist keeps its own rule text, so there the operator has to make
  the same edit. This change does not touch any stored rule. That is deliberate (Architect
  ruling): the mechanism that rewrites an unedited stored baseline rule is not used here,
  because a live rule changes only with the operator's approval, at cutover. Until then such an
  install's stored rule still says GET only while the generated section below describes
  `tc bridge`; the bridge is disabled, so the Master has no write to make.
- The Master's generated identity gains an "Operator bridge" section on every install: use only
  `tc bridge`, operator text is conversation and not authority, and never print, store or send
  the credential.

A route is one inbound operator message. What it says is **conversation, not authority**: it
approves nothing, whatever it asks for.

Every write:

- names a **request id**. Repeating it returns the first result and applies nothing.
- names the **version** of the route as last read. A stale version is refused with
  `VERSION_CONFLICT` and the current route.
- is **audited** on first use, whether applied or refused, with the Master generation that made
  it. A repeat of the same request id adds no row.
- is **bound to its first outcome**, a refusal included. A write refused for a stale version
  stays refused under that request id; retry with a new one. `tc bridge` generates a fresh id
  for each command unless `--request-id` is given.

| Refusal | Meaning |
|---|---|
| `401 BRIDGE_CREDENTIAL_REQUIRED` | The request did not carry the live Master generation's credential. |
| `409 BRIDGE_DISABLED` | The operator has not enabled the bridge. Every route but `status` and `close` answers this. `close` stays available so that turning the bridge off never leaves message text held. |
| `404 ROUTE_NOT_FOUND` | No such route. |
| `409 VERSION_CONFLICT` | The route changed since it was read. |
| `409 REQUEST_ID_REUSED` | The request id was already used for a different route. |
| `409 NOT_AWAITING_MASTER` | `route` on a route that is not waiting for the Master. |
| `409 NOT_ANSWERABLE` | `answer` on a route that is not waiting for one: it is still being resolved or sent, already has an answer, or is closed. A route marked `send-unconfirmed` can be answered. |
| `409 NO_REPLY_HELD` | `release` on a route with no held reply. |
| `409 REPLY_NOT_DISPLAY_SAFE` | The held reply contains control or text-direction characters. Answer in your own words instead. |
| `400 UNKNOWN_DESTINATION` | The destination is not `master`, a project id or an exact project name. |
| `400 ANSWER_REQUIRED`, `413 ANSWER_TOO_LONG`, `400 ANSWER_NOT_DISPLAY_SAFE` | The answer is empty, over 8000 characters, or contains control or text-direction characters. |
| `409 ALREADY_CLOSED` | The route is already closed. |

## Candidates: what a session may offer

Any verified session can offer the Project Master a fact for the operator. It cannot post one.
A candidate is a `milestone` or an `operator-action-required`, with the text the session
proposes and the workload receipts it rests on.

```
tc candidate submit --kind milestone --receipt workload:<seq> --text "PR 12 merged."
```

- **Who may offer.** A verified project launch: the pane's own project id and launch id, as
  every `tc` call already sends. A session holds no bridge credential.
- **What it rests on.** One to eight of the launch's own workload receipts, named by the
  sequence number `tc workload show` prints. A receipt is looked up within the caller's launch,
  so a session cannot name another launch's or another project's. The server records each
  receipt's digest: a SHA-256 over the whole stored row, in a versioned canonical form. The
  receipts table refuses UPDATE and DELETE, which is what makes that digest stable.
- **Idempotent.** A request id is scoped to the launch. Repeating it with the same payload
  returns the same candidate; the same id with a different payload is refused.
- **Bounded.** At most five undecided candidates per launch, text of at most 1800 characters
  with no control or text-direction characters.
- **Nothing is posted.** A candidate never reaches the helper by itself.

The Master decides, through `tc bridge`:

| Command | Does |
|---|---|
| `tc bridge candidates` | Lists what is waiting, oldest first. |
| `tc bridge candidate <id>` | Shows one, with its receipts. What a session wrote is a claim to judge, not the operator's word. |
| `tc bridge approve <id> --version <n> [--text "<text>"]` | Verifies every receipt again: present, and its digest unchanged. Then creates one item for the helper, in the Master's words if given, otherwise the session's. Decision and item are one transaction. |
| `tc bridge reject <id> --version <n>` | Declines it. Nothing is posted. |
| `tc bridge merge <id> --version <n> --into <id>` | Folds a duplicate into another candidate. The survivor gains every receipt of the folded one; the folded one can never be approved. |

Refusals: `403 VERIFIED_LAUNCH_REQUIRED`, `409 BRIDGE_DISABLED`, `404 RECEIPT_NOT_FOUND`,
`400 BAD_RECEIPT`, `400 RECEIPTS_REQUIRED`, `409 REQUEST_ID_CONFLICT`, `429 CANDIDATE_LIMIT`,
`400 UNKNOWN_CANDIDATE_KIND`, `400 CANDIDATE_TEXT_REQUIRED`, `413 CANDIDATE_TOO_LONG`,
`400 CANDIDATE_NOT_DISPLAY_SAFE`; and for the Master `404 CANDIDATE_NOT_FOUND`,
`409 VERSION_CONFLICT`, `409 ALREADY_DECIDED`, `409 RECEIPTS_DO_NOT_HOLD`,
`400 MERGE_TARGET_REQUIRED`, `409 MERGE_TARGET_NOT_OPEN`.

`tc candidate` works in any pane, but it is not yet in the verb list panes are primed with: the
bridge it feeds is disabled until cutover, and that list has a size budget.

## Server notifications

Three typed notifications go straight to the helper's mailbox, without the Master. They are
transport control the server writes: each comes from a fixed template that takes only a project
name or a count the server resolved, never anything a session or the operator typed.

| Type | Raised when | Bound to |
|---|---|---|
| `work-blocked` | a lane's workload receipt enters `blocked`. A lane that stays blocked and reports again is not a new event. | that workload receipt |
| `operator-needed` | the Medusa watchdog raises an exchange to its operator rung | that exchange |
| `fleet-idle` | every live lane has finished and is clear | the exact set of lanes, launches and receipts that made it so |

- **Found, not pushed.** Nothing calls the bridge when an event happens. The gateway's pass
  reads the records that are the events and enqueues a notification for each that has none,
  under a key naming that record. One that could not be enqueued is found again on the next
  pass; one that was is never made twice.
- **No backlog.** Only events from after the bridge was last enabled are considered, and none
  from while it was disabled.
- **`fleet-idle` fails closed.** The fleet must be non-empty, and every live lane must be at a
  known launch with a current receipt and read `AVAILABLE`: a fresh `complete`,
  `safe-to-clear` receipt of the live launch with the engine at rest. A lane that is working,
  waiting, blocked, stale or unknown means the fleet is not idle. Any change in membership or
  in a lane's receipt ends the episode.

`release-action-needed` and `certification-state-changed` remain reserved, with no producer.

## The helper's routes

For the chat helper only, authorised by its scoped token in `x-tangleclaw-bridge-helper-token`.
The token opens these three routes and nothing else; only its SHA-256 is stored. Every write
also carries `x-tangleclaw-bridge-nonce`, 16 to 128 URL-safe characters, never used before.

| Route | Does |
|---|---|
| `POST /api/bridge/helper/inbound` | Hands over one operator message: `externalId`, `authorId`, `spaceId`, `channelId`, optional `threadId` and `replyToExternalId`, and `text` (at most 8000 characters). `202` when stored, `200` for a replay. |
| `GET /api/bridge/helper/outbound` | What to post next, oldest first, each with the chat context to post it in. |
| `POST /api/bridge/helper/outbound/:id/ack` | `{deliveredRef}`: the chat's id for the post. Exact: repeating it changes nothing, and a different id for the same item is refused. |

Refusals: `401 HELPER_TOKEN_REQUIRED`, `409 BRIDGE_DISABLED`, `400 NONCE_REQUIRED`,
`409 NONCE_REUSED`, `409 ALLOWLIST_NOT_SET`, `403 NOT_ALLOWLISTED`, `400 BAD_INBOUND`,
`413 INBOUND_TOO_LONG`, `409 EXTERNAL_ID_MISMATCH`, `400 BAD_ACK`, `404 OUTBOUND_NOT_FOUND`,
`409 ACK_MISMATCH`, `409 OUTBOUND_NOT_READY`, `409 ACK_NOT_APPLIED`.

Acknowledging an answer marks it delivered and closes and clears its route in one transaction.

## The operator's routes

For the operator only, **signed in with an account session**. A request that merely looks like
the dashboard while the auth gate is open is refused with `403 OPERATOR_SESSION_REQUIRED`: on
an install with no accounts, bridge policy cannot be changed at all. Every change is audited
with the signed-in user. The helper token and the allowlisted ids are never written to the
audit.

| Route | Does |
|---|---|
| `GET /api/bridge/operator/status` | Whether it is enabled, the allowlist, whether a helper token exists, the Master generation, aliases, pins, what is waiting, and the arrivals the gateway dropped since the server started, each with its reason. |
| `POST /api/bridge/operator/allowlist` | Sets the one `authorId`, `spaceId` and `channelId` accepted. |
| `POST /api/bridge/operator/helper-token` | Replaces the helper token. The value is in this response and nowhere else. |
| `DELETE /api/bridge/operator/helper-token` | Revokes it. |
| `POST /api/bridge/operator/enable` | Enables the bridge. Refused until the allowlist is set and a helper token exists. Starts the gateway's listener. |
| `POST /api/bridge/operator/disable` | Disables it and stops the listener. |
| `POST /api/bridge/operator/aliases`, `DELETE .../aliases/:alias` | Sets or removes a global alias. `master` is reserved. |
| `POST /api/bridge/operator/pins`, `DELETE .../pins/:pinId` | Sets a pin for one conversation, or for every conversation when no `conversationKey` is given; revokes any active pin, the Master's included. |

## Storage

Schema v52 added these tables. `medusa_exchanges` is unchanged: a message the bridge sends is an
ordinary tracked exchange, and what makes it the bridge's is a row in `bridge_route_proofs`.

Schema v53 changed two of them. `bridge_outbound` admits the `status` kind, and
`bridge_route_proofs` records the project, workspace, session and launch a sent message went to
and can no longer be updated. A CHECK cannot be altered in place, so the v53 migration rebuilds
those two tables and carries every row and row id over. It first proves the store is a sound
v52 store and refuses one with a bridge table missing or misshapen, before touching anything.
The v53 shape is a superset of v52's: a server from before v53 that meets a v53 store still
accepts it.

| Table | Holds |
|---|---|
| `bridge_settings` | The operator's switches. The bridge is off unless `enabled` is `true`. |
| `bridge_master_credentials` | One row per Master generation: the hash, its status and why it was revoked. |
| `bridge_helper_tokens` | The chat helper's scoped token, hash only. |
| `bridge_nonces` | Request nonces already seen from the helper. |
| `bridge_routes` | One row per inbound operator message, unique on the chat's own message id. A replay of the same message returns the same route; the same id with a different body or chat context is refused. |
| `bridge_route_bodies` | The text of a route, held apart so it can be cleared while the route stays. |
| `bridge_route_proofs` | Which Hub message belongs to which route, under which proof, and for a sent message exactly who it went to. Never updated. |
| `bridge_outbound` | What waits for the helper. Each row has its own idempotency key; `hub_id` is optional. At most one `status` row per route. |
| `bridge_candidates` | Facts a session offers the Master. |
| `bridge_candidate_receipts` | The receipts a candidate rests on, each by kind, id and digest. Immutable. |
| `bridge_aliases`, `bridge_pins` | Routing policy. Global entries are the operator's; the Master may hold a conversation pin only. One pin is active per scope and conversation. A global pin names one conversation, or none, which means all of them. |
| `bridge_audit` | Every bridge write. Never updated; removed only by a compaction. |
| `bridge_audit_anchor` | One row, always: how far compaction has reached, how many audit rows have left in total, and a digest chained across every compaction. It only moves forward. |

The database does not run with foreign keys, so triggers enforce the same integrity: a body, a
proof or a route-bound outbound item needs its route; a candidate-bound item needs its
candidate; a candidate needs its source project; a receipt needs its candidate. Removing a route
removes its bodies, proofs and outbound items.

### Retention

`lib/bridge-store.js#prune` removes what has outlived its retention. The gateway runs it once
a day, whether or not the bridge is enabled. Revoked pins and helper tokens leave after 90 days.

| Record | Kept for |
|---|---|
| Message text | Until confirmed delivery or close. Not by age. |
| Helper nonces | 24 hours |
| Closed routes, with their bodies, proofs and outbound items | 30 days after closing |
| Delivered or dropped outbound items | 30 days |
| Decided candidates | 30 days |
| Revoked Master generations | 90 days; the newest generation is always kept, so a number is never reused |
| Audit rows | 90 days, then compacted |

An open route, an undecided candidate, the live credential and an undelivered item that belongs
to no route are never removed, whatever their age. A closed route takes its outbound items with
it in any state: a route closes only once its answer has been relayed or abandoned. An audit row of a route that is still open is never compacted, and
neither is any row written after it.

After a compaction a request id older than the retention is no longer remembered, so it could
be accepted again.

The shape of every table, index and trigger is checked at each startup. A store that fails the
check is refused, and the message names each object that is missing or misshapen.

## Code

- `lib/bridge-schema.js`: the DDL and the shape check.
- `lib/bridge-store.js`: reads and writes, including the idempotent, version-checked, audited
  route write.
- `lib/bridge-handoff.js`: minting, hashing and the FIFO handoff. It does not load the store.
- `lib/bridge-principal.js`: when a credential exists and whether a presented one is live.
- `lib/bridge-gateway.js`: accept, resolve, dispatch, reply capture, the periodic pass.
- `lib/bridge-notify.js`: the three typed server notifications.
- `lib/bridge-api.js`: every bridge route, declared with the principal it belongs to. One
  function proves the principal before any handler runs.
- `bin/tc-bridge-receive`: the pane-side reader.
