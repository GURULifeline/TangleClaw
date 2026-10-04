'use strict';

/*
 * Early warning for the release notes gate (#2080). The release workflow
 * refuses notes over the gate's ceiling and never truncates them, so an
 * oversized [Unreleased] section would only be discovered at the version bump,
 * after everything in it has merged. This fails at merge time instead, on the
 * PR whose entry crosses the line, while there is still room to condense.
 *
 * What is measured is what the release would publish: the version bump
 * promotes [Unreleased] under a version heading unchanged, so the section is
 * promoted in memory and read back through the workflow's own extractor.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractReleaseNotes } = require('../lib/changelog-notes');
const { MAX_RELEASE_BODY_BYTES } = require('../scripts/release-notes-gate');

/** Where this test starts failing: far enough under the ceiling to leave room for entries still in flight. */
const EARLY_WARNING_BYTES = 110000;

/** A version no real release uses, standing in for the one the bump would assign. */
const PROMOTED = '0.0.0-unreleased-size-check';

/**
 * The UTF-8 size of the release notes [Unreleased] would become if it were
 * released now.
 * @param {string} changelogText - Full contents of CHANGELOG.md
 * @returns {number|null} Bytes (0 for an empty section), or null when there is no [Unreleased] heading.
 */
function unreleasedNotesBytes(changelogText) {
  const heading = /^## \[Unreleased\].*$/m;
  if (!heading.test(changelogText)) return null;
  const notes = extractReleaseNotes(changelogText.replace(heading, `## [${PROMOTED}]`), PROMOTED);
  return notes === null ? 0 : Buffer.byteLength(notes, 'utf8');
}

describe('CHANGELOG [Unreleased] size early warning (#2080)', () => {
  it('warns below the release gate\'s ceiling, not at or above it', () => {
    assert.ok(EARLY_WARNING_BYTES < MAX_RELEASE_BODY_BYTES);
  });

  it('[Unreleased] stays under the early-warning line', () => {
    const bytes = unreleasedNotesBytes(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
    assert.notEqual(bytes, null, 'CHANGELOG.md must have an [Unreleased] section');
    assert.ok(bytes <= EARLY_WARNING_BYTES,
      `[Unreleased] would publish ${bytes} UTF-8 bytes of release notes, over the ${EARLY_WARNING_BYTES}-byte early warning. `
      + `The release refuses notes over ${MAX_RELEASE_BODY_BYTES} bytes and never truncates them. `
      + 'Condense entries (keep every item, its headline and its references; cut implementation narration), or release what has accumulated.');
  });

  it('measures the section body only, in UTF-8 bytes', () => {
    const sample = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **é**\n\n## [1.0.0] - 2026-01-01\n\n- old\n';
    assert.equal(unreleasedNotesBytes(sample), Buffer.byteLength('### Added\n\n- **é**', 'utf8'));
    assert.equal(Buffer.byteLength('é', 'utf8'), 2);
  });

  it('counts a fenced "## " line as content, as the extractor does, so the count cannot stop early', () => {
    const fenced = '## [Unreleased]\n\n- entry\n\n```\n## not a heading\n```\n\n- after the fence\n\n## [1.0.0]\n\n- old\n';
    assert.equal(unreleasedNotesBytes(fenced), Buffer.byteLength('- entry\n\n```\n## not a heading\n```\n\n- after the fence', 'utf8'));
  });

  it('reads an empty section as 0 bytes and a missing one as null', () => {
    assert.equal(unreleasedNotesBytes('# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- old\n'), 0);
    assert.equal(unreleasedNotesBytes('# Changelog\n\n## [1.0.0]\n\n- old\n'), null);
  });

  it('fails a section over the line: the v5.30.0 notes that GitHub refused would have been caught', () => {
    const big = `## [Unreleased]\n\n${'- entry\n'.repeat(20000)}\n## [1.0.0]\n`;
    assert.ok(unreleasedNotesBytes(big) > EARLY_WARNING_BYTES);
  });
});
