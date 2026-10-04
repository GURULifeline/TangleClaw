# The operator bridge's Discord helper

The helper is a small local process, `bin/tc-bridge-helper`, that sits between Discord and the
[operator bridge](operator-bridge.md). It is the only thing that talks to Discord.

- **Discord to TangleClaw:** it listens to one Discord channel over the Gateway and hands the
  allowlisted operator's messages to the bridge.
- **TangleClaw to Discord:** it claims what the bridge has released for the operator, posts it
  in that channel, and acknowledges each item once Discord confirms the post.

It talks to TangleClaw through the bridge's five helper routes and nothing else. No session
has a path to Discord: an answer reaches the helper only after the Project Master releases it.

## Status

Built and tested against the real bridge routes and a stand-in for Discord. **It has not been
run against Discord.** The bridge is disabled by default and Rule #145's interim procedure
([discord-operator-notifications.md](discord-operator-notifications.md)) is still the only
Discord path in force. Installing the helper is part of cutover, which needs the security
review, a live round trip and the operator's approval. Do not set it up on a live install
because this page exists.

## What it will and will not do

- **Conversation, never authority.** A Discord message is handed over as conversation. It
  cannot approve a merge, a release, a deletion or any other privileged action, whatever it
  says, and the helper attaches no meaning to it.
- **One operator, one server, one channel, checked twice.** The helper ignores a message from
  anyone else, another server or channel, a bot (itself included) or a webhook. It decides on
  ids alone, before reading the text, and logs nothing for it, so nothing of theirs reaches
  TangleClaw, a log or a reply. The bridge then checks the same three ids against the operator's own allowlist. Both
  must agree.
- **One channel out.** The helper posts to its configured channel only. An item naming another
  channel is not posted.
- **Text only.** Attachments, voice and slash commands are not relayed.
- **No pings.** Relayed text cannot mention anyone.
- **No redirects.** Neither the bridge client nor the Discord client follows a redirect, so
  neither token is ever sent to a host other than the one configured.
- **A reaction means TangleClaw has the message, not that anyone read it.** The helper adds ✅
  once the bridge has stored the message. What happens next is in
  [operator-bridge.md](operator-bridge.md).
- **Messages sent while the helper is down are not caught up.** The Gateway does not replay
  them. Send them again once `status` shows the Gateway `ready`. Answers and notifications are
  different: they wait at the bridge, so none is lost while the helper or Discord is down.

## Setting it up

The bridge comes first: the operator sets its allowlist and creates the helper token, signed in
with an account session ([operator-bridge.md](operator-bridge.md), "The operator's routes").

### 1. The Discord application

In the Discord Developer Portal, for the application:

1. **Bot → Privileged Gateway Intents: turn on Message Content Intent.** Without it Discord
   refuses the connection (close code 4014), and `status` says so.
2. **Bot → Reset Token**, and keep the token for step 3. It is shown once.
3. **Invite the bot** to the server with these permissions in the operator's channel: View
   Channel, Send Messages, Read Message History and Add Reactions.
4. **In Discord, User Settings → Advanced → Developer Mode.** Then right-click to copy three
   ids: your own user id, the server id and the channel id. They are the same three the
   bridge's allowlist holds.

### 2. The helper's config

```sh
bin/tc-bridge-helper configure --base-url http://127.0.0.1:3102 \
  --author <your user id> --guild <server id> --channel <channel id>
```

This writes `~/.tangleclaw/bridge-helper/config.json`, owner-only. It holds no secret, and it
is outside the repository, so no Discord id is in a tracked file.

- `--base-url` is where TangleClaw answers. Plain `http://` is accepted only for this machine
  (`127.0.0.1`, `localhost`, `[::1]`); anywhere else must be `https://`. It may carry no user
  name or password.
- `--poll-seconds` (5 to 300, default 15) sets how often the helper asks what to post.
- A value that does not pass is refused, the field is named, and nothing is written.

### 3. The two secrets, in the Keychain

```sh
bin/tc-bridge-helper set-secret bot       # paste the Discord bot token
bin/tc-bridge-helper set-secret helper    # paste the bridge's bht_ helper token
```

Each command reads the token from standard input, with echo off at a terminal, stores it in
your login Keychain (service `tangleclaw-bridge-helper`) and reads it back to confirm. The token
travels to `security` on its standard input, so it is never in a command line (visible to
`ps`), an environment variable, a file or a log. A value that is not the shape of its token is
refused before anything runs. Never put either token in a repository, the config, the launchd
job or a shell command. `set-secret` takes no token as an argument.

### 4. Run it under launchd

```sh
bin/tc-bridge-helper install-launchd
```

This writes `~/Library/LaunchAgents/com.tangleclaw.bridge-helper.plist` from
`deploy/com.tangleclaw.bridge-helper.plist` and loads it. The job carries paths and a label
only. launchd starts the helper at login and restarts it if it exits, at most once every 30
seconds. `--no-load` writes the job without loading it.

## Operating it

- **`bin/tc-bridge-helper status`** shows whether the config is set, whether each secret is
  present (never its value), whether the helper is running, the Gateway's state, the last pass,
  how many items are in progress, and any item held for you. It shows no secret, no message text and no Discord id.
- **The log** is `~/.tangleclaw/logs/bridge-helper.log`: one JSON line per event, with a
  timestamp, a closed code, and ids or numbers. It never holds message text, tokens, headers or
  Discord's raw answers. The codes are listed in `lib/bridge-helper/log.js`. Nothing rotates
  this file. It gets a line per message relayed and per failure, not per poll, so it grows
  slowly; truncate it or add a `newsyslog` rule if it matters.
- **Stopping:** `launchctl bootout gui/$(id -u)/com.tangleclaw.bridge-helper`. The job file
  stays, and launchd loads it again at your next login.
- **Starting again:** `bin/tc-bridge-helper install-launchd`.
- **Only one helper runs.** A second refuses to start, because two would post every item twice.
  The lock names a process id and counts only if that process is a helper, so a lock left by a
  helper that died is taken over even when something else now has its id.

## Removing it

```sh
bin/tc-bridge-helper uninstall-launchd
security delete-generic-password -s tangleclaw-bridge-helper -a discord-bot-token
security delete-generic-password -s tangleclaw-bridge-helper -a bridge-helper-token
rm -r ~/.tangleclaw/bridge-helper
```

`uninstall-launchd` unloads the job and removes its file, and keeps the rest. Remove
`~/.tangleclaw/bridge-helper` only when `status` shows nothing held: it holds the record of
posts in progress. Then have the operator revoke the helper token at the bridge.

## How an item is delivered

The helper **claims** what waits at the bridge. Each item comes under a two-minute lease
([operator-bridge.md](operator-bridge.md), "Claims and leases"), and with the parts of it that
are already posted, if an earlier attempt got part-way.

Before posting, the helper checks the item's text against the digest it was handed over with,
and the channel it names against the configured one.

An item is posted as **who it is from**, in bold, then the text as written. An answer is posted
as a reply to the operator's message. Text longer than one Discord message is posted as several,
in order.

The helper tells the bridge about **each message as soon as Discord has made it**, and then
acknowledges the whole set, which seals the item. Nothing is acknowledged before Discord has
confirmed it. Because each part is reported at once, a reply to any part is known for what it
answers straight away, and whoever picks the item up next carries on after the parts already
posted.

A lease does not make a post safe to repeat. Three things do, together: the bridge's record of
the parts already posted; the helper's own record, `~/.tangleclaw/bridge-helper/state.json`,
for an attempt whose outcome is in doubt; and the nonce each post carries, which Discord uses
to refuse a repeat for a few minutes.

| What goes wrong | What happens |
|---|---|
| Discord is busy, or the network is down | Nothing is acknowledged. The helper reports it as `transient`, backs off (to at most once every 5 minutes) and tries again. The item waits. |
| The helper posts, then cannot report or acknowledge | The post is on the helper's record. It reports and acknowledges on a later pass and never posts it again. |
| The lease lapses part-way through | The bridge hands the item over again with the parts already posted. The helper carries on after them. |
| The helper restarts, or loses its own record | The same: the bridge says which parts are posted. A restart also asks for the claim it was working on again, under its own nonce, and gets the same leases. |
| A claim's answer is lost | The claim is asked again under its own nonce. |
| A post's outcome is unknown (a timeout, a server error) | The helper reports `outcome-unknown` and retries with the same nonce for up to 2 minutes; Discord returns the message it already made. |
| Past those 2 minutes | A retry could duplicate the post, so the helper holds the item as `uncertain` and reports `outcome-unverifiable`. The bridge sets the item aside and tells you. |
| Discord rejects the item's content (HTTP 400) | The helper reports `rejected-by-chat`. The bridge sets the item aside and tells you. The items after it keep moving. |
| Discord says the chat is closed to the bot | The helper believes only a code Discord gave: unknown channel, unknown server, missing access or permissions, or a refused bot token (401). It reports that, the bridge sets the item in hand aside and opens its configuration circuit, and nothing more is handed over until the Master or the operator resets it. A bare 403 or 404 with no such code is treated as passing. |
| The message an answer replies to is gone | The answer is posted by itself, not as a reply. That is not a broken channel. |
| The bridge's record of an item's parts disagrees with the helper's | The helper reports `part-conflict` and posts nothing more of it. The bridge sets it aside. |
| The helper token was replaced | The old token's leases are no longer the helper's, and the bridge says nothing about their items. Items still waiting are handed to the new token with their parts. |
| The bridge let the item go, set it aside, or the Master withdrew it | The helper is not told which. Its lease is simply no longer live, and the item is not handed over again. Once the bridge holds every part the helper posted, the helper drops its own record. Anything already posted stays in the channel. |
| The record cannot be written | The helper posts nothing it could not record first, logs `state-write-failed` and tries again later. A part that did post before a write failed is remembered while the helper runs; if the helper also stops before it can write, the restarted helper finds the attempt on record as in doubt and falls back on the nonce, or holds the item as `uncertain`. |

One case leaves something behind. If the helper posted a part, could not report it, and the
bridge then let the item go, the bridge never hands that item over again and the helper's
record of the part stays where it is. `status` counts it under "in progress". It does no harm;
remove it by removing the record once nothing else is in progress.

## Items set aside

**The helper cannot discard anything.** What it cannot post, the bridge sets aside: the item
keeps its text, is handed to nobody, and one notice is posted in the channel saying that
something was set aside. The Project Master lists these with `tc bridge blocked` and decides:

- `tc bridge requeue <item-id>` puts the item back. The helper picks it up on its next pass
  (once any open configuration circuit has been reset) and
  carries on after any parts already posted.
- `tc bridge withdraw <item-id>` gives it up for good.

The operator can make the same two decisions from a signed-in session
([operator-bridge.md](operator-bridge.md), "The operator's routes").

For `rejected-by-chat` that is all there is to do: put right what Discord refused, then
requeue.

### When the whole chat is closed to the bot

If the channel or server is missing, the bot may not post there, or its token is refused, the
bridge opens its **configuration circuit**. The helper logs `bridge-configuration-blocked` on
every pass and posts nothing. The notice cannot reach you through Discord; `tc bridge status`
and `GET /api/bridge/operator/status` show it, and the server log carries a warning.

Put the configuration right (the bot's permissions in the channel, or `set-secret bot` for a
new token, then restart the helper). Then the Master runs `tc bridge reset --requeue`, or
`--withdraw` to give up what was caught. Nothing closes the circuit by itself.

### Settling an `uncertain` item

`outcome-unverifiable` needs one more thing, because only you can see whether the part in
doubt reached the channel. `status` lists it:

```
item 12: uncertain, part 2 (settle it: see docs/operator-bridge-helper.md)
```

Stop the helper, look in the channel, then run the one command that matches what you see.
`settle` refuses to run while the helper does.

| What you see | Command | What happens |
|---|---|---|
| The part did post. | `settle <id> --posted <discord message id>` | The id is recorded for that part. |
| The part did not post. | `settle <id> --repost` | The part will be posted again, under a new nonce. |

Then start the helper and have the Master run `tc bridge requeue <id>`. The helper reports the
part you recorded, posts any parts after it, and acknowledges the item.

"The part" is the one `status` names: with `part 2`, part 1 posted and is recorded, and part 2
is the one in question. `--posted` takes the id of that one part.

## Messages the operator sees when one is not taken

The helper replies to the message in fixed words and adds no ✅. Nothing of the message or of
TangleClaw's answer is echoed.

| The reply says | Why |
|---|---|
| the TangleClaw operator bridge is turned off | The bridge is disabled. |
| the bridge has no allowlist set | The operator has not set one. |
| TangleClaw does not allow this author, server or channel | The ids do not match the bridge's allowlist. |
| the text is over 8000 characters | The bridge's length limit. |
| the message has no text | An attachment or sticker with no text. |
| TangleClaw refused the helper's token | The token was replaced. Run `set-secret helper` with the new one. |
| TangleClaw could not accept this message | The bridge found the message malformed. |
| TangleClaw could not be reached | Three attempts failed, or the server answered with a redirect. Send it again later. |

## Troubleshooting by log code

| Code | Meaning and what to do |
|---|---|
| `config-missing`, `config-invalid` | Run `configure`. The helper exits with status 78 and contacts nothing. |
| `secret-missing`, `secret-read-failed` | Run `set-secret` for the secret `status` names. `secret-read-failed` can also mean the login Keychain is locked. |
| `state-unreadable` | `state.json` is damaged. The helper will not start without it, because forgetting a post in flight could make it twice. Move it aside only after checking the channel for what it names. |
| `state-write-failed` | `state.json` could not be written: a full disk, or permissions. The helper keeps trying and posts nothing it could not record. |
| `helper-already-running` | Another helper is running, or the helper could not check whether one is (`ps` failed): it does not start on a guess. With `pid: -1` the lock file `helper.pid` is unreadable. Either way, check that no helper runs (`pgrep -fl tc-bridge-helper`), then delete the lock file. |
| `gateway-fatal` | Discord refused the connection for a reason a retry cannot fix. 4004 is a bad bot token (run `set-secret bot`); 4014 means Message Content Intent is off. The helper keeps posting, but reads nothing until it is restarted. |
| `bridge-configuration-blocked` | The bridge's configuration circuit is open; see "When the whole chat is closed to the bot". |
| `outbound-chat-closed` | Discord said the chat is closed to the bot, and the bridge was told. |
| `outbound-reply-target-missing` | The message an answer replied to is gone; the answer was posted by itself. Nothing to do. |
| `claim-failed` | The bridge could not be asked what to post. The status is in the line: `0` is no answer, `401` a replaced token, `409` a disabled bridge. |
| `redirect-refused` | A server answered with a redirect, which the helper never follows. Check `--base-url`. |
| `outbound-uncertain` | An item is held here and set aside at the bridge; see "Settling an `uncertain` item". |
| `outbound-rejected`, `outbound-part-conflict` | The bridge was asked to set an item aside; see "Items set aside". |
| `outbound-report-failed` | The bridge could not be told that an item could not be posted. It is told again on the next pass. |
| `outbound-ack-failed` | A posted item could not be reported or acknowledged: the bridge did not answer, or the helper's lease on it is no longer live. If the item is still waiting it is handed over again and acknowledged then. |
| `outbound-digest-mismatch`, `outbound-foreign-channel` | An item did not pass the helper's checks and was not posted. Either is a defect to report. |
| `outbound-pass-failed` | A pass ended on a failure the helper did not expect. The line gives the failure's type and never its message. Report it, with the lines around it. |

## What is not proven here

The automated tests cover every rule on this page against the real bridge routes and a
stand-in for Discord (`test/bridge-helper-*.test.js`). These need the operator's own Mac and
Discord account, and belong to the live verification before cutover:

- the Keychain items and the launchd install, restart and throttle;
- that Discord honours the nonce as documented, for how long;
- the Gateway against Discord itself: identify, resume, and the close codes;
- one two-way conversation, and one of each notification.

## Code

- `bin/tc-bridge-helper`: the launcher.
- `lib/bridge-helper/cli.js`: the commands.
- `lib/bridge-helper/config.js`, `secrets.js`, `state.js`, `log.js`: the config, the Keychain,
  the record of posts and the closed-code log.
- `lib/bridge-helper/bridge-client.js`: the five bridge routes, and nothing else.
- `lib/bridge-helper/discord-rest.js`, `discord-gateway.js`: Discord's REST API and Gateway.
  `discord-gateway.js` is carried over from the helper written for #1799, which never merged.
  That is this project's own earlier work, kept because it speaks only Discord's protocol. It
  inherits nothing from the contract #1799 was written against, and is reviewed as new code.
- `lib/bridge-helper/inbound.js`, `outbound.js`: the two directions.
- `deploy/com.tangleclaw.bridge-helper.plist`: the launchd job's template.
