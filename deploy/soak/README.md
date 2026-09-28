# Release-candidate soak — load and fault schedule

The load side of the 72-hour release-candidate soak (#2020, part of #1949). It builds a
**deterministic** schedule of load and faults, then runs it against a TangleClaw server inside
an isolated test guest. Every outcome goes to an append-only log.

It judges nothing. Whether the release candidate passes is decided by the release-certification
judge (`rc-cert`) and the soak's own acceptance gates. This tool only produces the conditions and
records what happened.

> **Status: partial.** This directory has the schedule, the runner for the `api` and `engine`
> load classes, and the stub engine. Three pieces are not built yet:
> - the guest itself;
> - the executors for the `browser` and `fault` classes;
> - integrity sampling, the evidence bundle and the operator runbook.
>
> Until the missing executors exist, `run` **refuses** any schedule containing those kinds
> (`NO_EXECUTOR`) rather than skipping them. Plan with `--classes api,engine` to run the load
> that exists today.

## Build a schedule

```sh
node scripts/soak.js plan --seed rc-5.30.0 --phase certifying --duration-hours 72 \
  --out soak-certifying.json
node scripts/soak.js validate --schedule soak-certifying.json
```

- **The same seed and flags always give the same schedule and the same `digest`**, so the evidence can
  name exactly what a run was put through, and a rerun can reproduce it.
- **The phase decides the fault catalogue.** Neither phase can put an owned-ttyd restart into a
  certifying run:
  - A `certifying` schedule **never** contains an owned-ttyd restart (`fault.ttyd.restart`). That
    fault changes the ttyd generation, which fails a certification outright.
  - A `destructive` schedule may contain one. Run it in its own phase, then reset to a pristine
    guest before certification begins.
  - `validate` rejects a certifying schedule that contains that fault even if it was edited by hand
    and its digest recomputed.
- **Faults are spaced by at least `--fault-quiet-ms`** (default: 10 minutes), so the system gets a
  window to recover before the next one.
- **The params must be written out in full**, exactly as `plan` writes them. A key deleted by hand is
  refused, not silently defaulted.
- **The params have fixed limits, so a hand-edited schedule cannot widen them:**
  - project names must be synthetic (`soak-…`);
  - lease ports stay at 5000 or above, outside TangleClaw's own ranges;
  - an engine cycle sends at most 20 commands;
  - the load and fault gaps have floors;
  - a schedule holds at most 300,000 events. A 72-hour run at the one-second floor is 259,200.
- **`plan` never overwrites** an existing schedule file.

## Run it

```sh
TANGLECLAW_SERVICE_TOKEN=… node scripts/soak.js run --schedule soak-certifying.json \
  --api http://<guest-address>:<port> --log soak-certifying.ndjson
```

- **`--api` is required and has no fallback.** The load writes port leases and sessions, so before
  any load `run` refuses the TangleClaw named by this pane's own `TANGLECLAW_API`
  (`LIVE_INSTALL_TARGET`) in three ways:
  - **By spelling.** It refuses the same origin, and any spelling of this machine on the live port,
    in either scheme:
    - loopback: `127.0.0.0/8`, `[::1]`, and IPv4-mapped forms such as `[::ffff:127.0.0.1]`;
    - `localhost` and any `*.localhost` name, with or without a trailing dot;
    - the hostname or its MagicDNS name;
    - any local interface address.
  - **By resolution.** It resolves the target's name and refuses when any address it gets is on this
    machine, which catches names no spelling rule anticipates. It fails closed: a name that does not
    resolve, or resolves to nothing, is refused (`TARGET_UNRESOLVED`). It resolves `TANGLECLAW_API`'s
    own name too. When that name is a Tailscale or LAN name rather than the hostname, `127.0.0.1` on
    the live port is still refused, and a live name that does not resolve counts as this machine.
  - **By identity.** It asks both servers for `/api/server-info` and refuses a target that reports the
    same running server (`startedAt` and `startupSha`), which catches a reverse-proxy route.
- **If the live install's identity cannot be read, `run` refuses** (`LIVE_IDENTITY_UNREADABLE`).
  `--allow-unverified-live` overrides this, and the override is recorded in the log header. If only
  the target cannot be read, `run` warns (`IDENTITY_UNCHECKED`) and carries on: a target that answers
  nothing, or answers `401`, answers the load the same way.
- **With no `TANGLECLAW_API`, `run` refuses (`GUARD_CONTEXT_ABSENT`) unless `--no-live-install` is
  given.** Every guard compares against `TANGLECLAW_API`, so without it nothing is guarded, and that
  has to be stated rather than assumed.
  - Inside the soak guest, where the driver targets the guest's own TangleClaw, pass
    `--no-live-install`. The log header records it.
  - Passing it where `TANGLECLAW_API` is set is a usage error.
  - Neither override is ever passed on the operator's behalf, least of all by certification.
- **The target must already have the synthetic projects** (`--projects`, default `soak-a`,
  `soak-b`, `soak-c`) and no delete password. Otherwise every session cycle is logged as a `404`
  or `403`.
- **The token comes from `TANGLECLAW_SERVICE_TOKEN` only.** `--token` is refused.
- **The log is `0600`, and one driver holds it at a time** (`<log>.lock`, `LOG_LOCKED`). A lock left
  by a dead process on this host is reclaimed, and the reclaim is logged. Each record is flushed to
  disk before the next event.
- **The log is evidence, so nothing rewrites it.** Reading it changes nothing. A final line torn by
  a crash is sealed by appending after it: a newline, then a `torn-tail-sealed` record naming its
  size. Its event runs again.
- **Ctrl-C stops within a second, before the next event** (exit 4), even during a long wait, and says so on stderr. Running the same command again resumes, and no
  logged event runs twice.
- **An engine cycle cleans up only the harness's own sessions.** It first reads the project's
  session status:
  - a leftover `soak-stub` session, left by a cycle torn by a crash, is killed (`preKilled: true`);
  - a session on any other engine is never touched, and the cycle fails with `FOREIGN_SESSION`;
  - if the status cannot be read, the cycle kills nothing.
- **On time, every event runs at its slot. Behind schedule:**
  - Load more than a minute past its slot is **skipped and recorded** (`skipped: true`,
    `SKIPPED_STALE`), never replayed as a backlog.
  - Faults are **never skipped, only deferred**. A fault never starts within the quiet window of the
    previous executed fault, including one the log shows ran before a restart. Every fault runs
    before the log ends.
  - Overdue load that is not yet stale runs at least a second apart.
  - Each record says what applied (`paced`), and `lateMs` says how late it started.

Exit codes: 0 done, 2 usage, 3 refused (the code is printed as JSON on stderr), 4 stopped.

```sh
node scripts/soak.js run --schedule s.json --api http://<guest>:<port> --log s.ndjson [--allow-unverified-live] [--no-live-install]
```

## The stub engine

The guest has no network access and holds no vendor credentials, so the `engine` load uses
`stub-engine/soak-stub.js`:
- It is a deterministic program with no network access. Each input line gets
  `ack <n> <sha256 prefix>`, and `/exit` ends it.
- In the guest it is installed as `soak-stub` on `PATH`, with `stub-engine/soak-stub.json` copied into
  `~/.tangleclaw/engines/`.

It exercises TangleClaw's side of a session: launch, tmux, ttyd, command injection and kill.
**Real-vendor engine behaviour is outside this soak.**
