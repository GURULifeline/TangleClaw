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
- **`plan` never overwrites** an existing schedule file.

## Run it

```sh
TANGLECLAW_SERVICE_TOKEN=… node scripts/soak.js run --schedule soak-certifying.json \
  --api http://<guest-address>:<port> --log soak-certifying.ndjson
```

- **`--api` is required and has no fallback.** `run` refuses the TangleClaw named by this pane's own
  `TANGLECLAW_API` (`LIVE_INSTALL_TARGET`), because the load writes port leases and sessions.
- **The token comes from `TANGLECLAW_SERVICE_TOKEN` only.** `--token` is refused.
- **The log is `0600`.** Each record is flushed to disk before the next event.
- **Ctrl-C stops before the next event** (exit 4). Running the same command again resumes: no
  logged event runs twice. Every event keeps its original wall-clock slot, and one that was missed
  while the runner was down runs at once, with its lateness recorded.

Exit codes: 0 done, 2 usage, 3 refused (the code is printed as JSON on stderr), 4 stopped.

## The stub engine

The guest has no network access and holds no vendor credentials, so the `engine` load uses
`stub-engine/soak-stub.js`:
- It is a deterministic program with no network access. Each input line gets
  `ack <n> <sha256 prefix>`, and `/exit` ends it.
- In the guest it is installed as `soak-stub` on `PATH`, with `stub-engine/soak-stub.json` copied into
  `~/.tangleclaw/engines/`.

It exercises TangleClaw's side of a session: launch, tmux, ttyd, command injection and kill.
**Real-vendor engine behaviour is outside this soak.**
