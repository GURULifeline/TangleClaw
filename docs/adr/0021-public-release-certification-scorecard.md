# ADR 0021: Release-candidate certification is judged privately on the host and published through an allowlist to a guarded `metrics` branch

**Status:** Accepted (2026-09-27). This records the Architect's rulings on the C02 plan for #1949
(Q2–Q4, relayed by the ProjectManager) and the privacy design they rest on. Q1, which branch C02
builds on, was not ruled.
**Source issue:** #1949 (Train 30: v5.30.0 release-candidate certification and public scorecard).
**Builds on:** the C01 certification core (`lib/release-certification/`), which judges a 72-hour soak
of one exact candidate SHA and keeps its evidence private under
`<tangleclawHome>/release-certification/v1/`.

---

## Context

A release is certified by watching one candidate run for 72 healthy hours. The evidence that
decides it names the host, the candidate's worktree path and the owned ttyd's generation, which
contains a process id. So it lives on the host in a directory only the owner can read.

The decision has to be checkable by people other than that owner, and release promotion (C04) has
to be able to trust it. That creates two problems:

1. **A GitHub Action cannot read the evidence.** It runs in GitHub's cloud, and the evidence never
   leaves the host.
2. **A digest the owner can rewrite binds nothing.** The run's manifest (what is certified, and
   under which thresholds) is fixed by its sha256, stored beside the evidence. That catches an edit
   made out of band, but the owning user can rewrite the manifest and the digest together.

## Decision

1. **The host publishes, and GitHub guards.** The host builds the public documents and pushes them
   to a dedicated `metrics` branch, with no shared history with `main`. A GitHub check on that
   branch refuses any change that breaks the publishing rules. The most important rule is that an
   admission record, once published, never changes. An owner-configured ruleset on `metrics` forbids
   force-pushes and deletion. Together these put the manifest digest somewhere the host user cannot
   quietly rewrite, which is what makes it binding. Release promotion (C04) runs the same
   validators before it promotes.

2. **Public documents are built from an allowlist, never by deleting from private state.**
   `lib/release-certification/scorecard.js` builds every published document field by field, and its
   validators refuse any field they do not declare, at every nesting level. A field added to the
   private evidence later stays private until someone deliberately publishes it. The following are
   never published:
   - the worktree path, the host and the ttyd generation;
   - raw samples and probe diagnostics;
   - a failure's per-probe reasons (only its code and time are published).

3. **Fail closed at admission (ruling Q2).** `start` refuses until the candidate's admission record
   is published to `metrics` *and* has been read back and verified. No certification run begins
   unpublished. To keep a crash between publishing and committing the run from using up the
   candidate, `start` writes its manifest locally first and reuses it on a retry. Re-publishing the
   identical record is then a no-op, not a collision with the write-once rule.

4. **Publishing failures do not extend the soak (ruling Q3).** The scorecard is a view of the
   evidence, not evidence. After admission, a failed publish is recorded in `publish.json`, emitted
   as a `publish-failed` event (the runner's alert), shown by `rc-cert status`, and retried with
   backoff. Qualified time is unaffected. A final publish that fails when the runner exits is
   retried by hand with `rc-cert publish`. Ruling A1's "GitHub failure extends" applies to the
   GitHub *checks probe*, which judges the candidate, not to the push of our own scorecard. C04
   refuses promotion until every required fact is published.

5. **Unattended publishing is authorized, to `metrics` only (ruling Q4).** The runner may push
   without an operator present during a 72-hour run.
   - **What it pushes:** only the allowlisted documents, only under `release-certification/v1/` on
     `metrics`, never to a source branch and never by force.
   - **How it pushes:** from its own private clone of `metrics` (one per remote, under one lock, so
     runs of different candidates never share a working tree mid-publish), never from the
     candidate's worktree (which must stay exactly the candidate). At most one publish a minute,
     except a final state. The repository's git hooks are off, because
     they govern source work. Commits carry the operator's configured git identity.
   - **When the remote moved first:** a push rejected because another publisher got there first is
     rebuilt from the new tip and retried.

6. **The operator's actor id is published by default.** An acceptance or cancellation publishes the
   identifier the operator chose (for example `jason`), because a public certification should say
   who passed it. `rc-cert start --no-publish-actor` withholds it for that run, and only the time is published. Changing this
   default is a privacy decision and should come back here, not happen in code.

7. **One public scorecard, derived from the per-candidate files (Architect ruling, 2026-09-27).** The
   project publishes one combined `scorecard/v1.json`, with a `development` section (C03) and a
   `certification` section. The certification section (`tc.release-certification.summary/v1`: the
   candidate list and the newest candidate's scorecard) is a projection of the per-candidate files,
   built by `certificationSummary` and checked by `validateCertificationSummary`. The per-candidate
   admission, scorecard and event files stay the source of truth, because the write-once admission
   is what makes the manifest digest binding. A later chunk schedules the producer that writes the
   combined file.

## Consequences

- Until the owner creates the `metrics` ruleset, the digest is published but not tamper-proof. The
  C02 PR says so, and C04 must not treat the branch as binding before then.
- Admission now depends on GitHub being reachable. A GitHub outage delays a start but never
  shortens or lengthens a run in progress.
- There are three validators (the host before pushing, the branch check, and promotion) but one
  definition. A change to a published shape happens in `scorecard.js`, and all three follow.
- Times are published as epoch milliseconds in UTC. Human formatting, including the registry
  cards' America/Los_Angeles display, is the reader's job.
