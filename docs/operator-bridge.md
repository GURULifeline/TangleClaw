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
| Storage (schema v52) | Built |
| The Project Master's bridge credential | Built |
| `tc bridge` for the Project Master: status, list, read, close | Built |
| Gateway state machine, routing and reply release | Not built |
| Candidate notifications and typed server notifications | Not built |
| Discord helper | Not built |
| Cutover | Not started; Rule #145 is unchanged and in force |

The bridge is **disabled by default**, and nothing can enable it yet: the operator's local
switch arrives with the gateway. Until then `tc bridge status` answers and every other
`tc bridge` command answers `BRIDGE_DISABLED`. No route accepts a message from a chat
application, and nothing here posts to one.

### What ADR 0023 still requires

ADR 0023 is accepted for architecture only. Its acceptance does not authorise merging an
implementation, assigns no schema number and does not activate cutover. For this change:

- **Schema number.** 52 is the next free number on `main`, taken under the Architect's ruling
  of 2026-10-04. If another migration lands first, this one is renumbered.
- **Merge.** This change merges only after an exact-head independent security review. It is
  never set to merge automatically.
- **Cutover.** Not part of this change. It needs the security review, a live round trip and the
  operator's approval to replace Rule #145.

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

For the Project Master only. `bin/tc` forwards the credential from the pane's environment on
this verb and on no other, so it is never typed.

| Command | Does |
|---|---|
| `tc bridge status` | Says whether the bridge is enabled and which generation is asking. Answers while disabled. |
| `tc bridge routes [--state <state>]...` | Lists routes, oldest first, without bodies. Open states by default. |
| `tc bridge read <route-id>` | Shows one route with the text still held for it. |
| `tc bridge close <route-id> --version <n>` | Closes a route and clears its text. |

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

| Refusal | Meaning |
|---|---|
| `401 BRIDGE_CREDENTIAL_REQUIRED` | The request did not carry the live Master generation's credential. |
| `409 BRIDGE_DISABLED` | The operator has not enabled the bridge. Every route but `status` answers this. |
| `404 ROUTE_NOT_FOUND` | No such route. |
| `409 VERSION_CONFLICT` | The route changed since it was read. |
| `409 ALREADY_CLOSED` | The route is already closed. |
| `409 REQUEST_ID_REUSED` | The request id was already used for a different route. |

## Storage

Schema v52 adds these tables. `medusa_exchanges` is unchanged: a message the bridge sends is an
ordinary tracked exchange, and what makes it the bridge's is a row in `bridge_route_proofs`.

| Table | Holds |
|---|---|
| `bridge_settings` | The operator's switches. The bridge is off unless `enabled` is `true`. |
| `bridge_master_credentials` | One row per Master generation: the hash, its status and why it was revoked. |
| `bridge_helper_tokens` | The chat helper's scoped token, hash only. |
| `bridge_nonces` | Request nonces already seen from the helper. |
| `bridge_routes` | One row per inbound operator message, unique on the chat's own message id. A replay of the same message returns the same route; the same id with a different body or chat context is refused. |
| `bridge_route_bodies` | The text of a route, held apart so it can be cleared while the route stays. |
| `bridge_route_proofs` | Which Hub message belongs to which route, under which proof and Master generation. |
| `bridge_outbound` | What waits for the helper. Each row has its own idempotency key; `hub_id` is optional. |
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

`lib/bridge-store.js#prune` removes what has outlived its retention. Nothing calls it on a
schedule yet; the gateway will. Until then the only table that grows is
`bridge_master_credentials`, by one row per Master launch.

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
- `lib/bridge-api.js`: the `/api/bridge/master/*` handlers.
- `bin/tc-bridge-receive`: the pane-side reader.
