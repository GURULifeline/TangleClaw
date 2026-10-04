# Medusa wake monitor: scale and lifecycle measurements

Measured 2026-10-04 for #2086, on `main` at `4abe838d` plus the read-only instrumentation this
measurement added. Nothing here changes how a wake is judged or delivered. It records what the
monitor does today, so that the changes #2086 asks for are shaped by numbers.

Regenerate the tables with `node scripts/medusa-wake-matrix.js`.

## What was measured, and how

- **The monitor is real; the fleet is synthetic.** `test/helpers/medusa-wake-matrix.js` drives
  `lib/medusa-wake.js`'s own tick through its seams, with session records in these states: no
  mail, idle with mail, busy, a draft in the composer, an unprofiled engine, a listener that is
  off, and a session that ended between the roster read and its scan. No live session was used.
- **Time is virtual.** Each seam call advances one clock by a stated cost, and ticks fire the way
  Node fires an interval: the next is due one interval after the previous one *started*. The
  output is the same on every machine.
- **Two costs are measured, the rest are estimates.** One `tmux` command took 18.5 ms at the
  median and 42 to 63 ms at the 95th percentile, timed against a throwaway tmux server on the
  development host. A pane capture is one command and a cursor probe is two. In-process lookups
  are modelled at under a millisecond each. Measured separately with zero-cost seams, the tick's
  own JavaScript took about 0.2 ms for 30 sessions.
- **Mail is waiting at time 0** and the eligible recipient's pane is at rest throughout.

What the numbers cannot say: the real cost of the store and of a native engine observer, and
anything about the live server. The instrumentation that would answer those
(`medusaWake.tickMetrics()`, `medusaWatchdog.tickMetrics()`) is in the code and is not yet exposed
on any route.

## The matrix

"First assessed" is when the monitor first read the eligible recipient's pane. "Woken" is when the
nudge was typed. "Latest start" is how late the worst tick began.

#### Mixed fleet, eligible recipient scanned last

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| mixed | 1 | 307 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 2 | 307 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 5 | 420 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 10 | 534 ms | 0 ms | 0 | 5.2 s | 10.5 s | 0 |
| mixed | 20 | 650 ms | 0 ms | 0 | 5.4 s | 10.6 s | 0 |
| mixed | 30 | 877 ms | 0 ms | 0 | 5.6 s | 10.9 s | 0 |

#### Mixed fleet, eligible recipient scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| mixed | 1 | 307 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 2 | 307 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 5 | 420 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 10 | 534 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 20 | 650 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 30 | 877 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |

#### Every other session holds mail in a busy or drafting pane

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| median tmux cost | 1 | 307 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| 95th-percentile tmux cost | 1 | 399 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| median tmux cost | 2 | 363 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 2 | 548 ms | 0 ms | 0 | 5.2 s | 10.5 s | 0 |
| median tmux cost | 5 | 532 ms | 0 ms | 0 | 5.2 s | 10.5 s | 0 |
| 95th-percentile tmux cost | 5 | 995 ms | 0 ms | 0 | 5.7 s | 11.0 s | 0 |
| median tmux cost | 10 | 814 ms | 0 ms | 0 | 5.5 s | 10.8 s | 0 |
| 95th-percentile tmux cost | 10 | 1739 ms | 0 ms | 0 | 6.4 s | 11.7 s | 0 |
| median tmux cost | 20 | 1378 ms | 0 ms | 0 | 6.1 s | 11.4 s | 0 |
| 95th-percentile tmux cost | 20 | 3228 ms | 0 ms | 0 | 7.9 s | 13.2 s | 0 |
| median tmux cost | 30 | 1942 ms | 0 ms | 0 | 6.7 s | 11.9 s | 0 |
| 95th-percentile tmux cost | 30 | 4717 ms | 0 ms | 0 | 9.4 s | 14.7 s | 0 |

#### A pane read that times out (5 s) is scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| one hung pane | 2 | 5307 ms | 58 ms | 2 | 10.0 s | 15.4 s | 0 |
| one hung pane | 5 | 5421 ms | 171 ms | 2 | 10.1 s | 15.6 s | 0 |
| one hung pane | 10 | 5479 ms | 230 ms | 2 | 10.2 s | 15.7 s | 0 |
| one hung pane | 20 | 5650 ms | 403 ms | 2 | 10.4 s | 16.1 s | 0 |
| one hung pane | 30 | 5878 ms | 632 ms | 2 | 10.6 s | 16.5 s | 0 |
| two hung panes | 30 | 10879 ms | 5633 ms | 2 | 15.6 s | 26.5 s | 0 |
| three hung panes | 30 | 15823 ms | 10578 ms | 2 | 20.5 s | 36.4 s | 0 |

#### A scan that throws is scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| one throwing scan | 2 | 307 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| one throwing scan | 5 | 421 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| one throwing scan | 10 | 478 ms | 0 ms | 0 | 5.2 s | 10.5 s | 0 |
| one throwing scan | 20 | 650 ms | 0 ms | 0 | 5.4 s | 10.6 s | 0 |
| one throwing scan | 30 | 877 ms | 0 ms | 0 | 5.6 s | 10.9 s | 0 |

#### Restart and departure

| Run | Result |
|---|---|
| Restart after the nudge, durable attempt record readable | 0 duplicate nudges |
| Restart after the nudge, durable attempt record unreadable | 1 duplicate nudge(s) |
| Busy recipient leaves the roster with mail deferred | nudged 0 times; its last ledger row stays `skipped pane-turn-in-flight` and nothing supersedes it |
| Same, and a replacement session of the project joins | replacement nudged 1 time; the departed session's `skipped` row remains |

## What the numbers show

1. **Fleet size alone does not starve a recipient.** With a mixed fleet, 30 sessions add about
   0.6 s to a wake that takes 10.3 s with one. Scan position costs the last session about 0.6 s
   against the first.
2. **The floor is two ticks.** A recipient at rest is woken about 10.3 s after its mail arrives,
   at every fleet size: up to one interval before the first look, then the two-tick idle debounce.
   Nothing triggers a look when the mail arrives or when a pane comes to rest.
3. **What costs time is sessions that hold mail, because each is two tmux reads.** A session with
   no mail, an unprofiled engine, a stopped listener or an ended session returns before any tmux
   call. With mail in every pane, 30 sessions make a 1.9 s tick at median tmux cost and a 4.7 s
   tick at the 95th percentile, against a 5 s interval.
4. **The tick is synchronous, so its duration is a stall of the whole server.** `lib/tmux.js`
   uses `execSync`. For as long as a tick runs, no HTTP request, WebSocket frame or other timer
   is served. The real-timer run (`--real`) shows the longest event-loop stall equal to the
   longest tick in every case.
5. **One hung pane delays everyone behind it by its timeout, every tick.** tmux calls time out at
   5 s, which is the tick interval. One pane that times out and is scanned first turns a 10.9 s
   wake into 16.5 s at 30 sessions. Two make it 26.5 s, and three 36.4 s. The recipient is still
   woken, exactly once. The scan order is the roster's order, so the same session is first every
   tick.
6. **A scan that throws costs nothing.** The tick catches it and moves on.
7. **No run produced a duplicate nudge or typed into a pane that was not at rest.**
8. **A restart does not repeat a nudge while the durable attempt record is readable.** The
   in-memory watermark is lost, and `alreadyAttempted` restores it. If that read throws, the
   monitor falls back to memory, which is empty after a restart, and nudges a second time.

## The hypotheses on #2086

| Hypothesis | Result |
|---|---|
| A large fleet pushes back the tick slot of the one session that has mail | **Refuted** for quiet sessions: they cost well under a millisecond each. |
| Per-session lookups before the mail check add up across a fleet | **Refuted** at 30 sessions, with the estimated lookup costs. Not measured against the real store. |
| Contention among sessions that do have mail can delay a wake | **Confirmed.** About 56 ms per such session at the median, all of it tmux. |
| A slow early-scanned session can starve a later one | **Confirmed as delay, not as starvation.** One 5 s timeout per hung pane per tick, compounding. |
| The tick has no overrun or queue-lag handling | **Confirmed.** A tick that overruns starts the next one late and nothing records it. |
| Retry is interval polling, blind to state transitions | **Confirmed.** Finding 2. |
| An ended or listener-off session is reported as undelivered for ever | **Confirmed**, below. |

## What `/api/medusa/deliveries` returns today

Read from the code, and checked against one live read of the route on 2026-10-04.

- **A row is the newest ledger entry of a session whose last outcome was not `nudged`.** The
  ledger (`medusa_deliveries`) is written only while a session is being scanned with unread mail.
- **Nothing writes a row when a session ends.** A session that was last seen busy, wrapping or
  drafting keeps that `skipped` row. The synthetic run shows it: the departed session is never
  typed into, and its last row is never superseded.
- **A replacement session does not clear it.** Rows are keyed by session id. The project's next
  session gets its own row and its own nudge, and the departed session's row stays.
- **The route's own filter keeps such a row for ever.** `_stillHasUnhandledMail` returns true as
  soon as the session's listener is `off` or has no workspace, before it looks at the exchange
  record. An ended session has no listener.
- **The exchange record already knows better.** Session teardown ends that workspace's open
  exchanges as `recipient_retired` and tells their senders. The deliveries route does not consult
  it for a session without a listener.
- **The row carries no liveness, no age and no next action.** Its fields are the session, project
  and workspace ids, the message key, the unread count, the outcome, the skip reason and
  `createdAt`. `createdAt` is when the verdict last *changed*, which is neither when the mail
  arrived nor when the monitor last looked.

The live read returned 103 rows, dated from 2026-08-21 to that morning:

| Rows | What they are |
|---|---|
| 5 | Sessions in the live roster this session could see (16 sessions). All five were held by a busy pane or engine minutes earlier. |
| 98 | Sessions not in that roster. The roster was a partial view, so a few of these may be live. |

By skip reason, the 98 were: `wrap-running` 53, `pane-writing` 15, `pane-turn-in-flight` 11,
`engine-thread-busy` 7, `unprofiled-engine` 5, `pane-agents-running` 3, `engine-channel-absent` 2,
`wake-not-opted-in` 1, `engine-thread-unknown` 1. Over half are sessions whose last scan fell
inside their own wrap, which is the last thing a session does.

So today the route cannot tell current backlog from historical records. Classifying its rows needs
three facts it does not have: whether the session is still live, what the exchange record says
about its mail, and when the monitor last assessed it.

## Live observations on the day

Two cases seen on the live fleet on 2026-10-04 while this was being measured. Both are
observations with a hypothesis, not measurements.

- **A long turn holds inbound mail while outbound mail works.** A blocking message to a Builder
  aged at 5 minutes with the blocker `pane-writing`, which the monitor had reported continuously
  for 15 minutes. In that window the same Builder sent its sender a progress message. The inbox
  stayed queued.
- **Three dispatches sat unread while the recipient's pane was writing.** The session measuring
  this received them only when its turn ended, with `pane-writing` on its ledger row.

Each deferral was correct: the pane was not at rest, and nothing may be typed into it. The
hypothesis is about what is missing around the gate. Sending mail does not make a session read its
own inbox, so an agent in a long turn can talk and not listen. And because the monitor only polls,
a wake waits for the pane to be at rest on two consecutive ticks, which a session that works
without pause may not offer for a long time.

## Not measured

- The live server's tick durations. The meter is in place; reading it needs a route or a log line.
- The native engine observer's cost (`engine-thread-*` verdicts). The synthetic fleet uses a
  pane-judged engine.
- The delivery watchdog under load. Its pass is metered and tested, and no matrix was run over it.
- The duplicate case against the real `lib/medusa-exchanges.js`. The harness models the durable
  attempt record as a set.
