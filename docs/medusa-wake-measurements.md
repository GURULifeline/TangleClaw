# Medusa wake monitor: scale and lifecycle measurements

Measurements for #2086. Regenerate the tables with `node scripts/medusa-wake-matrix.js`.

**This revision supersedes the first one.** The first measurement (2026-10-04, `main` at
`4abe838d`) modelled a pane capture as one tmux command and a cursor probe as two. `lib/tmux.js`
runs four and three. Every figure that depended on that model is replaced below; "What the first
measurement got wrong" lists them. The tables now describe the monitor with non-blocking pane
reads, and "Before and after" compares it with `main` at `4b0d8b2e`, where every read blocked.

## What was measured, and how

- **The monitor is real; the fleet is synthetic.** `test/helpers/medusa-wake-matrix.js` drives
  `lib/medusa-wake.js`'s own tick through its seams, with session records in these states: no
  mail, idle with mail, busy, a draft in the composer, an unprofiled engine, a listener that is
  off, and a session that ended between the roster read and its scan. No live session was used.
- **Time is virtual.** Each seam call advances one clock by a stated cost, a non-blocking read
  answers at a stated later time, and ticks fire the way Node fires an interval. The output is the
  same on every machine.
- **The tmux costs are measured; the rest are estimates.** Against a throwaway tmux server on the
  development host:
  - one `tmux` command took 18.5 ms at the median and 42 to 63 ms at the 95th percentile;
  - the blocking readers run seven commands for a session holding mail (four for the pane, three
    for the cursor), about 130 ms;
  - the non-blocking reader runs four, about 74 ms alone;
  - thirty non-blocking reads started together finished in 1.2 s, each taking about a second,
    with the longest gap between two turns of the event loop at 0.34 s. The same thirty sessions
    read by blocking calls held the loop for 4.7 s.
  In-process lookups are modelled at under a millisecond each. The tick's own JavaScript took
  about 0.2 ms for 30 sessions.
- **Mail is waiting at time 0** and the eligible recipient's pane is at rest throughout.

What the numbers cannot say: the real cost of the store and of a native engine observer, and
anything about the live server. The instrumentation that would answer those
(`medusaWake.tickMetrics()`, `medusaWatchdog.tickMetrics()`) is in the code and is not yet exposed
on any route. The model does not charge for starting the reads' processes, which is the 0.34 s
gap above at thirty sessions.

## The matrix

The timer's path: every pane read is non-blocking. "First assessed" is when the monitor first
asked for the eligible recipient's pane. "Woken" is when the nudge was typed. "Longest tick" is
how long a tick held the thread.

#### Mixed fleet, eligible recipient scanned last

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| mixed | 1 | 1 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 2 | 2 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mixed | 5 | 3 ms | 0 ms | 0 | 5.0 s | 10.4 s | 0 |
| mixed | 10 | 7 ms | 0 ms | 0 | 5.0 s | 10.5 s | 0 |
| mixed | 20 | 13 ms | 0 ms | 0 | 5.0 s | 10.5 s | 0 |
| mixed | 30 | 19 ms | 0 ms | 0 | 5.0 s | 10.7 s | 0 |

#### Every other session holds mail in a busy or drafting pane

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| mail in every pane | 1 | 1 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| mail in every pane | 2 | 2 ms | 0 ms | 0 | 5.0 s | 10.4 s | 0 |
| mail in every pane | 5 | 4 ms | 0 ms | 0 | 5.0 s | 10.5 s | 0 |
| mail in every pane | 10 | 9 ms | 0 ms | 0 | 5.0 s | 10.6 s | 0 |
| mail in every pane | 20 | 17 ms | 0 ms | 0 | 5.0 s | 11.0 s | 0 |
| mail in every pane | 30 | 26 ms | 0 ms | 0 | 5.0 s | 11.4 s | 0 |

#### Pane reads that time out are scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| one hung pane | 2 | 2 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| one hung pane | 5 | 4 ms | 0 ms | 0 | 5.0 s | 10.4 s | 0 |
| one hung pane | 10 | 7 ms | 0 ms | 0 | 5.0 s | 10.4 s | 0 |
| one hung pane | 20 | 13 ms | 0 ms | 0 | 5.0 s | 10.5 s | 0 |
| one hung pane | 30 | 19 ms | 0 ms | 0 | 5.0 s | 10.7 s | 0 |
| two hung panes | 30 | 20 ms | 0 ms | 0 | 5.0 s | 10.7 s | 0 |
| three hung panes | 30 | 20 ms | 0 ms | 0 | 5.0 s | 10.7 s | 0 |
| ten hung panes | 30 | 22 ms | 0 ms | 0 | 5.0 s | 10.6 s | 0 |

#### A scan that throws is scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| one throwing scan | 2 | 1 ms | 0 ms | 0 | 5.0 s | 10.3 s | 0 |
| one throwing scan | 5 | 4 ms | 0 ms | 0 | 5.0 s | 10.4 s | 0 |
| one throwing scan | 10 | 7 ms | 0 ms | 0 | 5.0 s | 10.4 s | 0 |
| one throwing scan | 20 | 13 ms | 0 ms | 0 | 5.0 s | 10.5 s | 0 |
| one throwing scan | 30 | 19 ms | 0 ms | 0 | 5.0 s | 10.7 s | 0 |

#### Restart and departure

| Run | Result |
|---|---|
| Restart after the nudge, durable attempt record readable | 0 duplicate nudges |
| Restart after the nudge, durable attempt record unreadable | 1 duplicate nudge(s) |
| Busy recipient leaves the roster with mail deferred | nudged 0 times; its last ledger row stays `skipped pane-turn-in-flight` and nothing supersedes it |
| Same, and a replacement session of the project joins | replacement nudged 1 time; the departed session's `skipped` row remains |

## What the numbers show

1. **Fleet size alone does not delay a recipient.** A quiet session costs well under a
   millisecond, and a session holding mail no longer holds the tick at all.
2. **Mail for a pane at rest is nudged about 4.4 s after it arrives.** The arrival asks the
   monitor for a look, and a pane found at rest gets its second look one minimum gap (4 s) later.
   On the timer alone the same nudge took between 5.4 and 10.2 s, depending on where in the
   interval the mail landed. "From arrival to the nudge" below has the table.
3. **Sessions holding mail are read at the same time.** Thirty of them add about a second to the
   wake, which is the tmux server answering thirty readers, and nothing to the tick.
4. **The tick no longer stalls the server.** It runs the cheap gates and starts the reads. On
   `main` it held the whole server for as long as its reads took: 4.2 s for thirty sessions with
   mail, 51 s behind ten hung panes.
5. **A hung pane delays nobody.** Its read times out after 4 s by itself, and the pane is then
   left alone for 10, 30, then 60 s. A recipient behind ten hung panes is woken at 10.6 s, the
   same as with none.
6. **A scan that throws costs nothing.** The tick catches it and moves on.
7. **No run produced a duplicate nudge or typed into a pane that was not at rest.**
8. **A restart does not repeat a nudge while the durable attempt record is readable.** The
   in-memory watermark is lost, and `alreadyAttempted` restores it. If that read throws, the
   monitor falls back to memory, which is empty after a restart, and nudges a second time.

## From arrival to the nudge

A pane at rest, with no mail when the monitor last ticked. Mail then arrives.

| Sessions | Mail arrives after a tick by | Timer only | Arrival asks for a look |
|---|---|---|---|
| 1 | 0.1 s | 10.2 s | 4.4 s |
| 1 | 2.5 s | 7.8 s | 4.4 s |
| 1 | 4.9 s | 5.4 s | 4.4 s |
| 30 | 0.1 s | 10.2 s | 4.4 s |
| 30 | 2.5 s | 7.8 s | 4.4 s |
| 30 | 4.9 s | 5.4 s | 4.4 s |

A request is not a command. It runs the scan the timer runs, through every gate, and a single
look never nudges: the debounce is still two at-rest observations of an unchanged pane, at least
4 s apart. A look that was asked for and finds the pane at rest books one follow-up for the
earliest moment a second observation can count, and the timer leaves that session alone until it
has run.

Four recorded transitions ask for a look: mail arrives for a session, its listener returns to
`listening`, its project's wrap finishes, its coordinator rotation closes. Requests are coalesced
per session and dropped when the monitor is stopped, when the pane is being read, has a follow-up
booked, is backed off, or was observed inside the minimum gap.

What still waits for the timer: a busy pane coming to rest. No engine pushes a "turn finished"
event to TangleClaw that the monitor could use. Claude Code has no Stop-hook endpoint here, and the
Codex app-server's `turn/completed` is watched only for the one startup turn TangleClaw itself
begins. So a recipient that is mid-turn when its mail arrives is found at rest by the next tick,
and nudged one tick after that.

## Before and after non-blocking reads

30 sessions. "Before" is `main` at `4b0d8b2e`, measured with the corrected cost model.

| Run | Longest tick, before | after | Recipient woken, before | after |
|---|---|---|---|---|
| Mixed fleet, recipient scanned last | 1.7 s | 0.02 s | 11.7 s | 10.7 s |
| Mail in every pane, median tmux cost | 4.2 s | 0.03 s | 14.2 s | 11.4 s |
| Mail in every pane, 95th-percentile tmux cost | 11.6 s, 2 overruns | not modelled | 28.0 s | not modelled |
| One hung pane scanned first | 6.7 s | 0.02 s | 18.1 s | 10.7 s |
| Two hung panes | 11.7 s | 0.02 s | 28.1 s | 10.7 s |
| Three hung panes | 16.6 s | 0.02 s | 37.9 s | 10.7 s |
| Ten hung panes | 51.2 s | 0.02 s | 107.1 s | 10.6 s |

The non-blocking model has one contention figure, taken from the thirty-read measurement, so it
has no separate 95th-percentile row.

## How a non-blocking read is kept safe

A read's answer arrives after the tick that asked for it, so nothing that tick decided is trusted:

- **The whole gate chain runs again** on the session as it is when the read answers, with the
  read standing in for the pane capture. A wrap or rotation that began, mail already read, a
  listener that dropped, a withdrawn opt-in or a wake recorded meanwhile refuses the nudge.
- **The read is dropped** when the monitor was stopped since, when the session is no longer live,
  when its id now names another project, pane or start time, or when its workspace changed.
- **Judging an answer asks tmux nothing.** A project session is re-read from the store. The Master
  has no store row, and its record is rebuilt without probing its pane again: the read that just
  answered probed that exact pane itself, without blocking.
- **Assessment and injection happen in the same turn** as the answer, so the pane is as fresh
  when it is typed into as it was on the blocking path.
- **One read per session at a time.** A tick that finds a read still in flight starts no second
  one.
- **A tick that got no look at a pane is not an observation of it.** A timeout, a failed read, a
  read still in flight and a backoff each end the idle streak, and a nudge then needs two fresh
  at-rest observations on consecutive ticks.
- **A slow answer is not an observation either.** A read that took 3 s or more is seconds old
  when it arrives. Nothing is assessed from it, the streak ends, and the pane is backed off.
- **Two observations must be 4 s apart.** An answer late in one tick and early in the next can be
  a second or two apart, and a pane that only paused is not at rest.
- **A read is bounded.** tmux is run without a shell, and a read that outlives 4 s is killed.

What still blocks, as it did before: a tick probes the Master's pane once with one tmux command,
and typing a nudge is synchronous.

## What the first measurement got wrong

| Figure | First measurement | Now |
|---|---|---|
| tmux commands per session holding mail | 3 | 7 |
| Cost of such a session, median | about 56 ms | about 130 ms |
| Tick with mail in every pane, 30 sessions, median | 1.9 s | 4.2 s |
| The same at the 95th percentile | 4.7 s, no overrun | 11.6 s, 2 overruns (on `main`) |
| Mixed fleet tick, 30 sessions | 0.9 s | 1.7 s |
| Wake behind one, two, three hung panes (on `main`) | 16.5, 26.5, 36.4 s | 18.1, 28.1, 37.9 s |

The direction of every finding held. Finding 3 is stronger than first reported: a fleet of 30
with mail in every pane already overruns the interval at ordinary tmux latency.

## The hypotheses on #2086

| Hypothesis | Result |
|---|---|
| A large fleet pushes back the tick slot of the one session that has mail | **Refuted** for quiet sessions: they cost well under a millisecond each. |
| Per-session lookups before the mail check add up across a fleet | **Refuted** at 30 sessions, with the estimated lookup costs. Not measured against the real store. |
| Contention among sessions that do have mail can delay a wake | **Confirmed** on `main`: about 130 ms per such session, serially. Removed by non-blocking reads. |
| A slow early-scanned session can starve a later one | **Confirmed as delay** on `main`. Removed by non-blocking reads. |
| The tick has no overrun or queue-lag handling | **Confirmed** on `main`. A tick that starts reads and returns has nothing left to overrun with. |
| Retry is interval polling, blind to state transitions | **Confirmed** on `main` before #2086. Arrival, a listener returning, a wrap finishing and a rotation closing now ask for a look. A pane coming to rest is still found by the timer: no pushed event for it exists. |
| An ended or listener-off session is reported as undelivered for ever | **Confirmed**, below. The rows are still returned, and are now classed `historical` or `configuration`, apart from current backlog. |

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

That is what the route returned when this was measured. It now classifies each row as
`actionable`, `configuration` or `historical`, with its age and what to do
([medusa-delivery.md](medusa-delivery.md), "What a held wake means"). The rows themselves are
unchanged and nothing is removed.

At the time, the route could not tell current backlog from historical records. Classifying its rows needs
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
- The native engine observer's cost (`engine-thread-*` verdicts). The synthetic fleet uses
  pane-judged engines (Claude and Antigravity profiles).
- The delivery watchdog under load. Its pass is metered and tested, and no matrix was run over it.
- The duplicate case against the real `lib/medusa-exchanges.js`. The harness models the durable
  attempt record as a set.
- The tmux server under more than thirty concurrent readers, and the non-blocking reads at
  95th-percentile tmux latency.
- A single pane that hangs while the tmux server answers for the others. Every tmux timeout this
  repository has recorded was a wedged server, where every read hangs. The matrix models the
  single-pane case because #2086 asks for it.
