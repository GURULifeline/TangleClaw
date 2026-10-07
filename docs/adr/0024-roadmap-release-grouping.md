# ADR 0024: Release Versions group one or more Trains, superseding one-train-one-release

**Status:** Accepted (2026-10-07). Records the Architect's ruling A84 on an Operator-directed
roadmap restructuring proposal. Amended same day, before merge, per the Architect's PR review of
this ADR: fixed a contradiction in Decision 4 (bucket/unscoped Trains stay visible in the unchanged
Train view, excluded only from the new Release view, not hidden in some third "backlog"), added
`target_release` canonicalization against existing `release:vX.Y` labels (Decision 1), and labeled
the Release view as planned targets rather than a shipped-version index (Decision 4). Implementation
(schema/generator changes, the train/issue sweep) is tracked separately and has not started.
**Source:** Operator request, relayed by the ProjectManager; ruled by the Architect as A84.
**Supersedes:** the shipping model ratified 2026-07-30 ("each version ships ONE train with all its
cars, v5.1 is one complete train, v5.2 the next"), where it conflicts — see Decision 2.
**Does not touch:** the Permanent Train Identity policy (#1942) — Train `id` remains immutable,
never derived from version, order, or status.

---

## Context

Two planning signals currently exist and don't agree with each other:

1. **Trains** (`board-data.json`, rendered by `build-board.py`) group issues thematically — Train
   1 "First Install, Completed", Train 3 "Session Switchboard", etc. Train membership is read live
   from each issue's GitHub **milestone** assignment, not stored in `board-data.json` itself; the
   file holds only each Train's identity and metadata (`id`, `kind`, `milestone`, `thesis`,
   `sequencing`, `verified`, `display_order`, `aliases`). Ten-plus Trains are assembled
   concurrently today.
2. **Release labels** (`release:v5.32`, `release:v5.40`, etc.) sit directly on individual issues,
   independent of Trains. As of this writing, 6 open issues carry `release:v5.32` and 12 carry
   `release:v5.40`, and none of those 18 belong to any assembled Train.

Under the 2026-07-30 shipping model, a Train *is* a release — so the model offers no way to
express "these three Trains together make up v5.40" or "this Train isn't scoped to a release yet,"
and the two signals above have drifted apart in practice. What actually ships in a given version is
decided separately, by what has merged and landed under `[Unreleased]` in `CHANGELOG.md` by the
time someone cuts a release — not by which Train is "done."

## Decision

1. **Add `target_release` to the Train schema in `board-data.json`.** A new, nullable, mutable
   string field, canonical form `"X.Y.Z"` (full semver, e.g. `"5.32.0"` — not `"v5.32"`). `null`
   means unscoped — not yet assigned to a release. This is a planning field, not a new identity
   field; it does not join, rename, or renumber anything the Permanent Train Identity policy
   governs.
   - **Normalization against existing `release:vX.Y` issue labels:** a label names a minor line
     (e.g. `release:v5.32`), not a patch; it maps to that line's next unreleased version at the
     time of reconciliation (typically `X.Y.0`) and is re-checked at sweep time, not assumed fixed.
     The label and `target_release` are never required to carry identical text — the label lives on
     the issue, `target_release` on the Train that issue ends up in.

2. **Cardinality, and the resulting policy supersession:**
   - One Train → **zero or one** `target_release`. A Train is never split across two releases; if
     a Train's cars span more than one intended release, it is **split into new, permanent Train
     IDs** (next unused integer per #1942 — never reuse, renumber, or retire the original's
     history).
   - One release → **one or many** Trains.
   - This second half — multiple Trains composing one release — is incompatible with the
     2026-07-30 model's "each version ships ONE train" wording. That clause is **superseded** by
     this ADR. The stale `release_gate` note and the generated board's intro copy must be updated
     to match before the Release view is presented as authoritative (tracked in the follow-up
     issue, not done by this ADR).

3. **`target_release` is forecast, not proof.** It states current planning intent. It is never
   evidence of what a release actually contains — that remains merged PRs, `CHANGELOG.md`, the git
   tag, or the release manifest. Nothing reads `target_release` as a release's shipped contents.

4. **Two views over one dataset.** The existing Train view (thematic) is **unchanged**:
   `build-board.py` continues to render every configured Train and bucket entry there exactly as it
   does today, regardless of `target_release`. The new Release view is additional, not a
   replacement — it groups Trains by `target_release` and rolls up their live-derived cars, and its
   index is the release-version list the Operator asked for. The Release view **excludes**
   `kind: "bucket"` entries and unscoped (`target_release: null`) Trains; excluded means **absent
   from this one new view**, not hidden anywhere else — they stay exactly as visible in the
   (unchanged) Train view as every other configured entry. The Release view is labeled as **planned
   targets**, not a complete or authoritative shipped-version index — see Decision 3; it shows
   intent, and actual release membership is still tag/CHANGELOG/manifest-derived.

5. **The 18 currently-orphaned labeled issues are reconciled individually**, not bulk-retargeted.
   A `release:vX.Y` label on an issue is a proposal to consider, never authority to force that
   issue into a Train or to silently set a Train's `target_release`. Each is folded into an
   existing Train that fits its theme, or becomes the seed of a new Train, on its own merits.

6. **Never rewrite historical shipped releases.** This ADR's mechanism is forward-looking; past
   Trains and the releases already cut from them are not retargeted or reorganized retroactively.

7. **Ownership, per `roadmap-board/RULES.md`:** the ProjectManager is the roadmap's primary
   maintainer and owns this ADR, the policy text, the Train/issue sweep, and Operator-escalated
   decisions on ambiguous targets; the PM may own the `board-data.json`/`build-board.py` schema and
   generator changes directly. **Builders remain strictly read-only on the roadmap** — the one
   standing exception (Pilot-B2, 2026-09-27) is scoped only to #1942 and does not cover this work.
   No Builder is assigned any part of this until a new, separately scoped `RULES.md` exception is
   recorded. The Architect may review disputed Train/version mappings but, under Rule #71, does not
   write the live checkout or run the generator itself.

## Consequences

- The board gains a second, release-grouped view without breaking the existing thematic one or the
  Train Identity policy.
- `build-board.py` needs a validated path from "Trains carrying the same `target_release`" to "a
  release's rolled-up car list," reconciled against live GitHub milestone membership rather than
  any stored car list.
- Some existing Trains whose cars genuinely span two release targets will be split into new Train
  IDs as part of the sweep; their history is preserved, not deleted.
- The stale one-train-one-release wording in the generated board's intro and in any other place it
  is asserted as current policy must be corrected once the Release view ships, so the two no longer
  contradict each other.

## Follow-up (tracked separately, not part of this ADR)

Tracked as [#2157](https://github.com/Jason-Vaughan/TangleClaw/issues/2157).


- Schema change to `board-data.json` (add `target_release`) and the corresponding `build-board.py`
  generator work for the Release view.
- The one-time sweep: assign or explicitly unscope `target_release` for every currently assembled
  Train (1–7, 16, 31, 32 at time of writing).
- Individual reconciliation of the 18 orphaned `release:v5.32`/`release:v5.40` issues.
- Update the board's generated intro copy once the above lands.
