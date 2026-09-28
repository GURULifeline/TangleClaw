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
- **The params have fixed limits, so a hand-edited schedule cannot widen them:**
  - project names must be synthetic (`soak-…`);
  - lease ports stay at 5000 or above, outside TangleClaw's own ranges;
  - an engine cycle sends at most 20 commands;
  - the load and fault gaps have floors.
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
    machine, which catches names no spelling rule anticipates. A name that does not resolve is let
    through, since nothing can connect to it.
  - **By identity.** It asks both servers for `/api/server-info` and refuses a target that reports the
    same running server (`startedAt` and `startupSha`), which catches a reverse-proxy route.
- **If the live install's identity cannot be read, `run` refuses** (`LIVE_IDENTITY_UNREADABLE`).
  `--allow-unverified-live` overrides this, and the override is recorded in the log header. If only
  the target cannot be read, `run` warns (`IDENTITY_UNCHECKED`) and carries on: a target that answers
  nothing, or answers `401`, answers the load the same way.
- **With no `TANGLECLAW_API` there is nothing to compare against.** That is the intended deployment:
  the driver runs inside the soak guest against the guest's own TangleClaw. Run from a plain host
  shell, it has no live install to protect, so point it only at a guest.
- **The target must already have the synthetic projects** (`--projects`, default `soak-a`,
  `soak-b`, `soak-c`) and no delete password. Otherwise every session cycle is logged as a `404`
  or `403`.
- **The token comes from `TANGLECLAW_SERVICE_TOKEN` only.** `--token` is refused.
- **The log is `0600`, and one driver holds it at a time** (`<log>.lock`, `LOG_LOCKED`). A lock left
  by a dead process on this host is reclaimed, and the reclaim is logged. Each record is flushed to
  disk before the next event.
- **Ctrl-C stops before the next event** (exit 4). Running the same command again resumes, and no
  logged event runs twice. An event that was in flight at a crash has no logged outcome, so it runs
  again. An engine cycle first clears any session its torn predecessor left running
  (`preKilled: true`).
- **On time, every event runs at its slot. Behind schedule, the run is paced, and each record says
  how (`paced`):**
  - A fault never starts within the schedule's quiet window of the previous fault. That includes a
    fault the log shows ran before a restart.
  - Overdue events run at least a second apart, never as one burst.
  - `lateMs` records how late each event started.

Exit codes: 0 done, 2 usage, 3 refused (the code is printed as JSON on stderr), 4 stopped.

```sh
node scripts/soak.js run --schedule s.json --api http://<guest>:<port> --log s.ndjson [--allow-unverified-live]
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
