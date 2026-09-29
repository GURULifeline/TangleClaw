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
   to a dedicated `metrics` branch, with no shared history with `main`. A GitHub check re-verifies
   the branch's whole history against the publishing rules (`scripts/scorecard-verify.js`). It runs
   from `main`, every 30 minutes and on demand, not on push to `metrics`: GitHub runs a
   push-triggered workflow from the pushed commit, and the data-only branch neither carries nor may
   carry workflow files. One living on `metrics` could also be edited by whoever pushes there. The most important rule is that an
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
   who passed it. `rc-cert start --no-publish-actor` withholds it for that run: only the time is
   published, and the run's commits carry a neutral identity instead of the operator's git name.
   The setting, and the remote the run publishes to, are pinned in the checksummed manifest, so no
   later failure can reset them. Changing this
   default is a privacy decision and should come back here, not happen in code.

7. **One public scorecard, derived from the per-candidate files (Architect ruling, 2026-09-27).** The
   project publishes one combined `scorecard/v1.json`, with a `development` section (C03) and a
   `certification` section. The certification section (`tc.release-certification.summary/v1`: the
   candidate list and the newest candidate's scorecard) is a projection of the per-candidate files,
   built by `certificationSummary` and checked by `validateCertificationSummary`. The per-candidate
   admission, scorecard and event files stay the source of truth, because the write-once admission
   is what makes the manifest digest binding. A later chunk schedules the producer that writes the
   combined file.

8. **Only canonical thresholds certify, and the record says where the checks came from** (PR
   review of #1962, relayed by the PM). `accept` refuses a run judged by non-canonical thresholds,
   and a published `passed` scorecard must carry `canonicalThresholds: true`, so a smoke run can
   never be mistaken for a certification. `requiredChecksSource` (`branch-protection` or
   `operator`) is published with the admission and every scorecard, so an auditor can tell a
   candidate judged by the repository's own rules from one judged by a hand-picked list.

9. **Verification checks that the history is internally consistent, not that a soak happened**
   (cumulative review of C02; narrowed after the PR #1975 review). One transition table in
   `codes.js` is shared by the state machine and the verifier. A published `awaiting-review` or
   `passed` must show its targets met, every state change and transition line must be one the
   table allows, and the times must agree with each other (`TIMELINE_INCONSISTENT`): the run starts
   no earlier than its admission; qualified time is at most `elapsedMs` and at most
   `updatedAt - admittedAt`; `elapsedMs` is the span the scorecard's own times give; transition
   times never go back, begin at the run's start and fall within `[admittedAt, updatedAt]`; and
   an acceptance comes no earlier than the review it accepts. The PR review found a history
   claiming the full 72 qualified hours a minute after admission that passed every earlier rule;
   it now fails. Every time judged is one the publisher wrote, so the verifier refuses a history
   that contradicts itself, not one that is consistent and invented: how long a run really took
   rests on who can push to `metrics` (the ruleset below). The state machine keeps its own output
   inside these rules even when the clock is stepped: earned time never exceeds how far
   `updatedAt` moved, and transition, acceptance and cancellation times are clamped to it. The
   publisher runs the verifier on each commit before pushing it; a violation fails the publish
   (`WOULD_VIOLATE`) instead of landing on a branch whose history is permanent.

## Consequences

- Until the owner creates the `metrics` ruleset, the digest is published but not tamper-proof. The
  C02 PR says so, and C04 must not treat the branch as binding before then.
- Admission now depends on GitHub being reachable. A GitHub outage delays a start but never
  shortens or lengthens a run in progress.
- There are three validators (the host before pushing, the branch check, and promotion) but one
  definition. A change to a published shape happens in `scorecard.js`, and all three follow.
- Times are published as epoch milliseconds in UTC. Human formatting, including the registry
  cards' America/Los_Angeles display, is the reader's job.
- **`metrics` is created by the publisher, as an orphan branch** (Architect disposition on PR
  #1975). The publisher's first publish starts from an empty tree, so the branch shares no
  history with `main`. A branch created in GitHub's UI inherits `main`'s source files, which the
  path allowlist forbids; once the ruleset prohibits force-push, that violation is permanent. The
  owner therefore creates the ruleset after the first publish, never the branch itself.
- **The branch holds regular files only.** A symlink, submodule or executable on `metrics` is
  refused by the publisher before it is checked out (`METRICS_TREE_UNSAFE`) and flagged by the
  verifier (`NOT_REGULAR_FILE`), because a clone that checked one out could be pointed at a file
  outside itself.
- **C03 must not publish `scorecard/v1.json` until the path allowlist and the verifier admit it.**
  Point 7 describes the combined file, but today `PUBLISHED_PATH` does not include it, so a
  producer that wrote it would fail every publish (`WOULD_VIOLATE`) and every branch check.
- **C04 judges from the admissions and scorecards, never from `index.json`.** The index is a
  projection the publisher rewrites on every publish; the write-once admission and the
  per-candidate scorecard and transition log are the authority, and promotion re-verifies them.
