# The operator bridge's Discord helper

The helper is a small local process, `bin/tc-bridge-helper`, that sits between Discord and the
[operator bridge](operator-bridge.md). It is the only thing that talks to Discord.

- **Discord to TangleClaw:** it listens to one Discord channel over the Gateway and hands the
  allowlisted operator's messages to the bridge.
- **TangleClaw to Discord:** it claims what the bridge has released for the operator, posts it
  in that channel, and acknowledges each item once Discord confirms the post.

It talks to TangleClaw through the bridge's three helper routes and nothing else. No session
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
  ids alone, before reading the text, so nothing of theirs reaches TangleClaw, a log or a
  reply. The bridge then checks the same three ids against the operator's own allowlist. Both
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
  and any item held for you. It shows no secret, no message text and no Discord id.
- **The log** is `~/.tangleclaw/logs/bridge-helper.log`: one JSON line per event, with a
  timestamp, a closed code, and ids or numbers. It never holds message text, tokens, headers or
  Discord's raw answers. The codes are listed in `lib/bridge-helper/log.js`.
- **Stopping:** `launchctl bootout gui/$(id -u)/com.tangleclaw.bridge-helper`. The job file
  stays, and launchd loads it again at your next login.
- **Starting again:** `bin/tc-bridge-helper install-launchd`.
- **Only one helper runs.** A second refuses to start, because two would post every item twice.

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
([operator-bridge.md](operator-bridge.md), "Claims and leases"). The helper posts the item and
acknowledges it under that lease, with Discord's id for the post. Nothing is acknowledged
before Discord has confirmed it.

Before posting, the helper checks the item's text against the digest it was handed over with,
and the channel it names against the configured one.

An item is posted as **who it is from**, in bold, then the text as written. An answer is posted
as a reply to the operator's message. Text longer than one Discord message is posted as several,
in order, and acknowledged with the first one's id.

A lease does not make a post safe to repeat. Two things do: the helper's own record,
`~/.tangleclaw/bridge-helper/state.json`, and the nonce each post carries, which Discord uses
to refuse a repeat for a few minutes.

| What goes wrong | What happens |
|---|---|
| Discord or the network is down | Nothing is acknowledged. The item waits at the bridge and is posted when Discord answers. The helper backs off, to at most once every 5 minutes. |
| The helper posts, then cannot acknowledge | The post is on record. The helper acknowledges it on a later pass and never posts it again. |
| The lease lapses between the post and the acknowledgement | The bridge hands the item over again under a new lease. The helper acknowledges it under that one, without posting. |
| The helper restarts part-way through | Its record names the claim it was working on. It asks the bridge for that same claim again, gets the same leases, and carries on. |
| A claim's answer is lost | The same: the claim is asked again under its own nonce. |
| A post's outcome is unknown (a timeout, a server error) | The helper retries with the same nonce for up to 2 minutes, and Discord returns the message it already made. |
| Past those 2 minutes | A retry could duplicate the post, so the item is held as `uncertain`. It is never reposted or acknowledged by itself. |
| Discord rejects the item's content (HTTP 400) | That item is held as `rejected`, and the ones after it keep moving. |
| Discord refuses for another reason (permissions, a rate limit) | The pass stops and the helper backs off. Nothing is held. |
| The bridge let the item go before the acknowledgement arrived | The helper drops its record and stops trying. The post stays in the channel. |
| The record cannot be written | The helper posts nothing it could not record first, logs `state-write-failed` and tries again later. |

## Settling a held item

A held item stays held until you settle it. `status` lists each one:

```
item 12: uncertain, part 2 (settle it: see docs/operator-bridge-helper.md)
item 15: rejected, part 1 (settle it: see docs/operator-bridge-helper.md)
```

Stop the helper first, look in the channel, then run the one command that matches what you
see. `settle` refuses to run while the helper does, and refuses a settlement that is not true
of the item, changing nothing.

| Held as | What you see | Command | What happens |
|---|---|---|---|
| `uncertain` | The part did post. | `settle <id> --posted <discord message id>` | The id is recorded for that part. The helper posts any parts after it, then acknowledges the item. |
| `uncertain` | The part did not post. | `settle <id> --repost` | The helper posts that part again, then the parts after it. |
| `rejected` | Nothing: Discord refused it. | `settle <id> --repost` | The helper tries again. Use it once what Discord refused is put right. |

"The part" is the one `status` names: with `part 2`, part 1 posted and is recorded, and part 2
is the one in question. `--posted` takes the id of that one part.

**A rejected item cannot be discarded.** The bridge has no route for the helper to discard an
item, and closing a route does not withdraw an answer already released. An answer Discord will
never accept therefore stays held at the helper and waiting at the bridge, handed over again
every two minutes and skipped each time, until its route is closed and 30 days later removed
by retention. Nothing is posted and nothing is lost, but it does not resolve by itself. This is
a known gap for the bridge's design to close, not something to work around by editing the
helper's record.

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
| `helper-already-running` | Another helper is running. With `pid: -1` the lock file `helper.pid` is unreadable; check that no helper runs (`pgrep -fl tc-bridge-helper`), then delete it. |
| `gateway-fatal` | Discord refused the connection for a reason a retry cannot fix. 4004 is a bad bot token (run `set-secret bot`); 4014 means Message Content Intent is off. The helper keeps posting, but reads nothing until it is restarted. |
| `claim-failed` | The bridge could not be asked what to post. The status is in the line: `0` is no answer, `401` a replaced token, `409` a disabled bridge. |
| `redirect-refused` | A server answered with a redirect, which the helper never follows. Check `--base-url`. |
| `outbound-uncertain`, `outbound-rejected` | An item is held; see "Settling a held item". |
| `outbound-ack-failed` | A posted item could not be acknowledged yet. It is acknowledged on a later pass. |
| `outbound-ack-expired` | The bridge had let the item go. Nothing to do. |
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
- `lib/bridge-helper/bridge-client.js`: the three bridge routes, and nothing else.
- `lib/bridge-helper/discord-rest.js`, `discord-gateway.js`: Discord's REST API and Gateway.
- `lib/bridge-helper/inbound.js`, `outbound.js`: the two directions.
- `deploy/com.tangleclaw.bridge-helper.plist`: the launchd job's template.
