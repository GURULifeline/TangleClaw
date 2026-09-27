'use strict';

/**
 * The rules the `metrics` branch must obey, judged one commit at a time.
 *
 * The publisher writes the branch, but nothing stops someone with push rights
 * writing it too. This verifier is how anyone (the scheduled GitHub check,
 * release promotion, or a person) confirms that the history is one the
 * publisher could have produced, and so that the admissions it holds still
 * bind their manifest digests (ADR 0021):
 *
 * - only published certification documents change, and none is ever deleted;
 * - every changed document validates, and names the candidate its path names;
 * - an admission, once written, never changes by a byte;
 * - a scorecard matches its candidate's admission (digest, version, thresholds
 *   flag, required-check source), its `publishSeq` rises, its time never goes
 *   back, a terminal state never changes, and review never goes back to a
 *   live state;
 * - a transition log is only appended to, starts with admission, chains each
 *   transition from the previous one's end, and agrees with its scorecard;
 * - the index agrees with every scorecard changed in the same commit, whether
 *   or not the index itself changed.
 *
 * Pure: it reads files through the two readers it is given, so the same rules
 * serve a git history, a test, or anything else holding two trees.
 *
 * @module lib/release-certification/verify
 */

const { execFile } = require('node:child_process');
const sc = require('./scorecard');
const { STATES, isTerminal } = require('./codes');

/** Rule codes a violation carries. */
const RULES = Object.freeze({
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  DELETED: 'DELETED',
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  WRONG_CANDIDATE: 'WRONG_CANDIDATE',
  ADMISSION_REWRITTEN: 'ADMISSION_REWRITTEN',
  SCORECARD_WITHOUT_ADMISSION: 'SCORECARD_WITHOUT_ADMISSION',
  SCORECARD_MISMATCH: 'SCORECARD_MISMATCH',
  SEQ_NOT_INCREASING: 'SEQ_NOT_INCREASING',
  TIME_BACKWARDS: 'TIME_BACKWARDS',
  TERMINAL_CHANGED: 'TERMINAL_CHANGED',
  REVIEW_REOPENED: 'REVIEW_REOPENED',
  EVENTS_REWRITTEN: 'EVENTS_REWRITTEN',
  EVENTS_BROKEN_CHAIN: 'EVENTS_BROKEN_CHAIN',
  EVENTS_SCORECARD_MISMATCH: 'EVENTS_SCORECARD_MISMATCH',
  INDEX_MISMATCH: 'INDEX_MISMATCH',
  MERGE_COMMIT: 'MERGE_COMMIT',
  HISTORY_UNREADABLE: 'HISTORY_UNREADABLE'
});

const DOC_RE = new RegExp(`^${sc.ROOT.replace(/[/.]/g, '\\$&')}(admissions|scorecards|events)/([0-9a-f]{40})\\.(json|ndjson)$`);

/**
 * Parse JSON, or null.
 * @param {string|null} text - Text
 * @returns {object|null} Parsed value
 */
function _json(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a transition log into lines, or null when a line is not JSON.
 * @param {string|null} text - Log text
 * @returns {object[]|null} Parsed lines
 */
function _lines(text) {
  if (text === null) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const doc = _json(line);
    if (doc === null) return null;
    out.push(doc);
  }
  return out;
}

/**
 * Judge a changed admission.
 * @param {string} sha - Candidate named by the path
 * @param {object} ctx - `{prev, next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _admission(sha, ctx, p) {
  const before = ctx.prev(p);
  if (before !== null) {
    ctx.violation(RULES.ADMISSION_REWRITTEN, p);
    return;
  }
  const doc = _json(ctx.next(p));
  if (!doc || sc.validateAdmission(doc).length > 0) ctx.violation(RULES.INVALID_DOCUMENT, p);
  else if (doc.candidateSha !== sha) ctx.violation(RULES.WRONG_CANDIDATE, p);
}

/**
 * Judge a changed scorecard against its admission and its previous version.
 * @param {string} sha - Candidate named by the path
 * @param {object} ctx - `{prev, next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _scorecard(sha, ctx, p) {
  const doc = _json(ctx.next(p));
  if (!doc || sc.validateScorecard(doc).length > 0) return ctx.violation(RULES.INVALID_DOCUMENT, p);
  if (doc.candidateSha !== sha) return ctx.violation(RULES.WRONG_CANDIDATE, p);
  const admission = _json(ctx.next(sc.paths(sha).admission));
  if (!admission) return ctx.violation(RULES.SCORECARD_WITHOUT_ADMISSION, p);
  if (doc.manifestDigest !== admission.manifestDigest || doc.version !== admission.version
    || doc.canonicalThresholds !== admission.canonicalThresholds || doc.requiredChecksSource !== admission.requiredChecksSource) {
    ctx.violation(RULES.SCORECARD_MISMATCH, p);
  }
  const before = _json(ctx.prev(p));
  if (!before) return undefined;
  if (!(doc.publishSeq > before.publishSeq)) ctx.violation(RULES.SEQ_NOT_INCREASING, p);
  if (doc.updatedAt < before.updatedAt) ctx.violation(RULES.TIME_BACKWARDS, p);
  if (isTerminal(before.state) && doc.state !== before.state) ctx.violation(RULES.TERMINAL_CHANGED, p);
  if (before.state === STATES.AWAITING_REVIEW && (doc.state === STATES.RUNNING || doc.state === STATES.EXTENDED)) {
    ctx.violation(RULES.REVIEW_REOPENED, p);
  }
  return undefined;
}

/**
 * Judge a changed transition log.
 * @param {string} sha - Candidate named by the path
 * @param {object} ctx - `{prev, next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _events(sha, ctx, p) {
  const before = ctx.prev(p) || '';
  const after = ctx.next(p);
  if (!after.startsWith(before)) return ctx.violation(RULES.EVENTS_REWRITTEN, p);
  const lines = _lines(after);
  if (lines === null || lines.some((l) => sc.validateEvent(l).length > 0)) return ctx.violation(RULES.INVALID_DOCUMENT, p);
  const chained = lines.length > 0 && lines[0].from === STATES.NOT_STARTED && lines[0].to === STATES.RUNNING
    && lines.every((l, i) => i === 0 || l.from === lines[i - 1].to);
  if (!chained) return ctx.violation(RULES.EVENTS_BROKEN_CHAIN, p);
  const card = _json(ctx.next(sc.paths(sha).scorecard));
  if (card && card.state !== lines[lines.length - 1].to) ctx.violation(RULES.EVENTS_SCORECARD_MISMATCH, p);
  return undefined;
}

/**
 * Judge a changed index against the scorecards changed alongside it.
 * @param {string[]} changedShas - Candidates whose scorecard changed in this commit
 * @param {object} ctx - `{next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _index(changedShas, ctx, p) {
  const doc = _json(ctx.next(p));
  if (!doc || sc.validateIndex(doc).length > 0) return ctx.violation(RULES.INVALID_DOCUMENT, p);
  for (const sha of changedShas) {
    const card = _json(ctx.next(sc.paths(sha).scorecard));
    const entry = doc.candidates.find((c) => c.candidateSha === sha);
    if (!card || !entry || entry.state !== card.state || entry.updatedAt !== card.updatedAt || entry.version !== card.version) {
      ctx.violation(RULES.INDEX_MISMATCH, p);
    }
  }
  return undefined;
}

/**
 * Judge one commit: the change from one tree to the next.
 * @param {object} change
 * @param {string[]} change.changed - Paths added or modified
 * @param {string[]} change.deleted - Paths removed
 * @param {function(string): (string|null)} change.prev - Reads a file from the tree before
 * @param {function(string): (string|null)} change.next - Reads a file from the tree after
 * @returns {{rule: string, path: string}[]} Violations; empty when the commit is one the publisher could have made
 */
function verifyChange(change) {
  const violations = [];
  const ctx = { prev: change.prev, next: change.next, violation: (rule, p) => violations.push({ rule, path: p }) };
  for (const p of change.deleted) ctx.violation(RULES.DELETED, p);
  const allowed = change.changed.filter((p) => {
    if (sc.PUBLISHED_PATH.test(p)) return true;
    ctx.violation(RULES.PATH_NOT_ALLOWED, p);
    return false;
  });
  const cardShas = [];
  for (const p of allowed) {
    const m = DOC_RE.exec(p);
    if (!m) continue;
    const [, kind, sha] = m;
    if (kind === 'admissions') _admission(sha, ctx, p);
    else if (kind === 'scorecards') {
      _scorecard(sha, ctx, p);
      cardShas.push(sha);
    } else _events(sha, ctx, p);
  }
  // Checked whenever a scorecard changed, not only when the index did: a
  // scorecard updated under a stale index is exactly the drift to catch.
  if (allowed.includes(sc.INDEX_PATH) || cardShas.length > 0) _index(cardShas, ctx, sc.INDEX_PATH);
  return violations;
}

/**
 * Run git in a repository for the verifier: read-only, never prompting.
 * @param {string} repoDir - Repository
 * @param {string[]} args - Arguments
 * @returns {Promise<{code: number, stdout: string}>} Result; never rejects
 */
function _git(repoDir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });
}

/**
 * Verify every commit on a branch, oldest first. A branch the publisher wrote
 * is linear, so a merge commit is itself a violation; the first commit is
 * judged against an empty tree.
 * @param {object} opts
 * @param {string} opts.repoDir - Repository holding the branch
 * @param {string} opts.ref - Branch or ref to verify (e.g. `origin/metrics`)
 * @param {function} [opts.git] - `(repoDir, args) => {code, stdout}` seam
 * @returns {Promise<{exists: boolean, commits: number, violations: {commit: string, rule: string, path: string|null}[]}>} Outcome
 */
async function verifyHistory(opts) {
  const git = opts.git || _git;
  const listed = await git(opts.repoDir, ['rev-list', '--reverse', '--parents', opts.ref, '--']);
  if (listed.code !== 0) return { exists: false, commits: 0, violations: [] };
  const commits = listed.stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  const violations = [];
  const show = async (rev, p) => {
    const r = await git(opts.repoDir, ['show', `${rev}:${p}`]);
    return r.code === 0 ? r.stdout : null;
  };
  for (const [commit, ...parents] of commits) {
    if (parents.length > 1) {
      violations.push({ commit, rule: RULES.MERGE_COMMIT, path: null });
      continue;
    }
    const diffArgs = parents.length === 0
      ? ['diff-tree', '--root', '--no-renames', '--no-commit-id', '-r', '--name-status', '-z', commit]
      : ['diff-tree', '--no-renames', '--no-commit-id', '-r', '--name-status', '-z', parents[0], commit];
    const diff = await git(opts.repoDir, diffArgs);
    if (diff.code !== 0) {
      violations.push({ commit, rule: RULES.HISTORY_UNREADABLE, path: null });
      continue;
    }
    const fields = diff.stdout.split('\0').filter((f) => f !== '');
    const changed = [];
    const deleted = [];
    for (let i = 0; i + 1 < fields.length; i += 2) (fields[i] === 'D' ? deleted : changed).push(fields[i + 1]);
    const prevFiles = new Map();
    const nextFiles = new Map();
    const needed = new Set([...changed, sc.INDEX_PATH]);
    for (const p of changed) {
      const m = DOC_RE.exec(p);
      if (m) {
        const docs = sc.paths(m[2]);
        needed.add(docs.admission);
        needed.add(docs.scorecard);
      }
    }
    for (const p of needed) {
      prevFiles.set(p, parents.length === 0 ? null : await show(parents[0], p));
      nextFiles.set(p, await show(commit, p));
    }
    const found = verifyChange({
      changed, deleted,
      prev: (p) => (prevFiles.has(p) ? prevFiles.get(p) : null),
      next: (p) => (nextFiles.has(p) ? nextFiles.get(p) : null)
    });
    for (const v of found) violations.push({ commit, ...v });
  }
  return { exists: true, commits: commits.length, violations };
}

module.exports = { RULES, verifyChange, verifyHistory };
