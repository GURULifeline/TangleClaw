#!/usr/bin/env node
'use strict';

/**
 * Fail a run when a test file requires bare `node:assert`.
 *
 * The testing convention is `node:test` with `node:assert/strict`. It was
 * ratified on 2026-08-01 with one file out of line, and by the time that file
 * was converted there were three: two written after the rule, from an older
 * file used as a template (#1067, #1377). A rule nothing checks describes a
 * set that regrows between filing an issue and doing it.
 *
 * The check reads the directory. It carries no list of files, so a new suite
 * is covered the day it is written, and it needs nothing installed.
 *
 * **An exception is written where it applies**, on the offending line or the
 * line above it, with a reason:
 *
 *     // prawduct:allow project/bare-assert -- <why this file needs loose assertions>
 *
 * A waiver with no reason, or for another rule, waives nothing.
 *
 * Usage: node scripts/assert-strict-guard.js [<directory>]   (default: test/)
 * Exit 0 when no test file requires bare node:assert, 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The waiver this check honours, and no other. */
const WAIVER_REF = 'project/bare-assert';

/** What to write instead, quoted in every finding. */
const REMEDY = "require('node:assert/strict')";

/**
 * A real bare require of the assertion module: either quote style (or a
 * template literal), with whatever whitespace a formatter leaves around the
 * parentheses and the string. `node:assert/strict` does not match, because the
 * closing quote must follow `assert` directly.
 */
const BARE_REQUIRE = /\brequire\s*\(\s*(['"`])node:assert\1\s*\)/;

/** A waiver for this check, with the reason it must carry. */
const WAIVER = new RegExp(`prawduct:allow\\s+(?:[\\w/-]+\\s*,\\s*)*${WAIVER_REF}(?:\\s*,\\s*[\\w/-]+)*\\s+--\\s*(\\S.*)$`);

/**
 * Every `*.test.js` file under a directory, at any depth, in a stable order.
 * `node_modules` is not descended into: what is installed there is not ours.
 * @param {string} dir - Directory to walk.
 * @returns {string[]} Absolute paths.
 */
function testFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...testFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Whether a match sits in a comment rather than in code: after `//` on its
 * line, or on a line of a block comment. A commented-out require is prose.
 * @param {string} line - The source line.
 * @param {number} index - Where the match starts on it.
 * @returns {boolean}
 */
function inComment(line, index) {
  const lead = line.trimStart();
  return lead.startsWith('*') || lead.startsWith('/*') || line.slice(0, index).includes('//');
}

/**
 * The reason a line gives for waiving this check, if it gives one.
 * @param {string|undefined} line - A source line.
 * @returns {string|null}
 */
function waiverReason(line) {
  const waived = line === undefined ? null : WAIVER.exec(line);
  return waived ? waived[1].trim() : null;
}

/**
 * Find every bare require of `node:assert` in the test files under a directory.
 * @param {string} dir - Directory to scan, recursively.
 * @param {string} [relativeTo] - What the reported paths are relative to. Defaults to the directory's parent.
 * @returns {{scanned: number, offenders: {file: string, line: number}[], waived: {file: string, line: number, reason: string}[]}}
 */
function scan(dir, relativeTo = path.dirname(path.resolve(dir))) {
  const files = testFiles(path.resolve(dir));
  const offenders = [];
  const waived = [];
  for (const full of files) {
    const file = path.relative(relativeTo, full).split(path.sep).join('/');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      const hit = BARE_REQUIRE.exec(text);
      if (!hit || inComment(text, hit.index)) return;
      // On the line itself, or alone on the line above it.
      const reason = waiverReason(text) || waiverReason(lines[i - 1]);
      if (reason) waived.push({ file, line: i + 1, reason });
      else offenders.push({ file, line: i + 1 });
    });
  }
  return { scanned: files.length, offenders, waived };
}

/**
 * What the check says about a scan, one line per finding.
 * @param {{scanned: number, offenders: object[], waived: object[]}} result - From {@link scan}.
 * @returns {string}
 */
function report(result) {
  const lines = result.waived.map((w) => `waived  ${w.file}:${w.line}  ${w.reason}`);
  if (!result.offenders.length) {
    return [...lines, `assert-strict-guard: ${result.scanned} test file(s), none requires bare node:assert.`].join('\n');
  }
  return [
    ...lines,
    ...result.offenders.map((o) => `${o.file}:${o.line}  requires bare node:assert; use ${REMEDY}`),
    `assert-strict-guard: ${result.offenders.length} of ${result.scanned} test file(s) checked require bare node:assert. `
      + `Change each to ${REMEDY}. A real exception takes "// prawduct:allow ${WAIVER_REF} -- <reason>" on that line or the one above.`
  ].join('\n');
}

if (require.main === module) {
  const result = scan(process.argv[2] || path.join(__dirname, '..', 'test'));
  const text = report(result);
  if (result.offenders.length) {
    console.error(text);
    process.exit(1);
  }
  console.log(text);
}

module.exports = { scan, report, testFiles, WAIVER_REF, REMEDY };
