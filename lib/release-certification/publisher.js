'use strict';

/**
 * Publishing certification documents to the `metrics` branch: the git mechanics.
 *
 * The publisher keeps its own clone of just that branch inside the private
 * evidence base. It never uses the candidate's worktree, which must stay
 * exactly the candidate. It never runs the repository's git hooks, which
 * govern source work, not data. Every publish starts from the remote's current
 * tip: it fetches, discards anything local, asks the caller to compute its
 * changes against what the remote holds now, commits and pushes.
 *
 * It never force-pushes. A push the remote rejects because someone else
 * published first is retried from the new tip, with backoff, a bounded number
 * of times. Only paths under `release-certification/v1/` that name a
 * certification document can be written, so this code cannot touch source
 * even by mistake.
 *
 * @module lib/release-certification/publisher
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const privateFs = require('./private-fs');
const { REFUSAL, CertificationError } = require('./codes');

const DEFAULT_BRANCH = 'metrics';
const PUSH_ATTEMPTS = 4;
const BACKOFF_MS = 2000;
const GIT_TIMEOUT_MS = 60 * 1000;

/** The only paths a publish may write. */
const ALLOWED_PATH = /^release-certification\/v1\/(?:(?:admissions|scorecards)\/[0-9a-f]{40}\.json|events\/[0-9a-f]{40}\.ndjson|index\.json)$/;

/**
 * Throw a publishing refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * Run git with the repository's hooks and signing turned off: this clone
 * holds data, and a hook meant for source work has no business here.
 * @param {string[]} args - Arguments
 * @param {object} opts - `{cwd, env}`
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Result; never rejects
 */
function runGit(args, opts) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Whether a push failure is the remote having moved (retry) rather than
 * anything else (give up).
 * @param {string} stderr - git's stderr
 * @returns {boolean} True for a non-fast-forward rejection
 */
function _rejectedAsBehind(stderr) {
  return /\[rejected\]|non-fast-forward|fetch first|failed to update ref|cannot lock ref/.test(stderr);
}

/**
 * Create a publisher.
 * @param {object} ctx
 * @param {string} ctx.dir - The private clone's directory
 * @param {string} ctx.remoteUrl - The repository to publish to
 * @param {{name: string, email: string}} ctx.identity - Commit author
 * @param {string} [ctx.branch] - Branch (default `metrics`)
 * @param {object} [deps] - `{git, sleep}` seams
 * @returns {object} `{publish, read}`
 */
function createPublisher(ctx, deps = {}) {
  const git = deps.git || runGit;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const branch = ctx.branch || DEFAULT_BRANCH;
  const env = {
    GIT_AUTHOR_NAME: ctx.identity.name, GIT_AUTHOR_EMAIL: ctx.identity.email,
    GIT_COMMITTER_NAME: ctx.identity.name, GIT_COMMITTER_EMAIL: ctx.identity.email,
    GIT_TERMINAL_PROMPT: '0'
  };

  /**
   * Run git in the clone, refusing on failure.
   * @param {string[]} args - Arguments
   * @param {string} step - What was being done, for the refusal
   * @returns {Promise<string>} stdout
   */
  async function must(args, step) {
    const r = await git(args, { cwd: ctx.dir, env });
    if (r.code !== 0) _refuse(REFUSAL.PUBLISH_FAILED, `git ${step} failed`, { step });
    return r.stdout;
  }

  /**
   * Make the private clone if it does not exist yet.
   * @returns {Promise<void>}
   */
  async function ensureClone() {
    privateFs.ensurePrivateDir(ctx.dir);
    if (fs.existsSync(path.join(ctx.dir, '.git'))) return;
    await must(['init', '-q', `--initial-branch=${branch}`], 'init');
    await must(['remote', 'add', 'origin', ctx.remoteUrl], 'remote add');
  }

  /**
   * Bring the clone to the remote's current tip, discarding anything local.
   * When the remote has no such branch yet, start an empty one.
   * @returns {Promise<boolean>} True when the remote branch exists
   */
  async function sync() {
    const fetched = await git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: ctx.dir, env });
    if (fetched.code !== 0) {
      const probe = await git(['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: ctx.dir, env });
      if (probe.code !== 2) _refuse(REFUSAL.PUBLISH_FAILED, 'could not reach the metrics remote', { step: 'fetch' });
      await git(['update-ref', '-d', `refs/remotes/origin/${branch}`], { cwd: ctx.dir, env });
      await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: ctx.dir, env });
      await git(['update-ref', '-d', `refs/heads/${branch}`], { cwd: ctx.dir, env });
      await must(['read-tree', '--empty'], 'read-tree');
      await must(['clean', '-q', '-fdx'], 'clean');
      return false;
    }
    await must(['checkout', '-q', '-B', branch, `refs/remotes/origin/${branch}`], 'checkout');
    await must(['reset', '-q', '--hard', `refs/remotes/origin/${branch}`], 'reset');
    await must(['clean', '-q', '-fdx'], 'clean');
    return true;
  }

  /**
   * Read a published file as the local clone holds it after `sync`.
   * @param {string} rel - Repository-relative path
   * @returns {string|null} Contents, or null when absent
   */
  function readLocal(rel) {
    try {
      return fs.readFileSync(path.join(ctx.dir, rel), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Write the changed files, refusing any path outside the allowlist.
   * @param {Object<string, string>} files - Path to contents
   * @returns {string[]} Paths written
   */
  function writeFiles(files) {
    const written = [];
    for (const [rel, text] of Object.entries(files)) {
      if (!ALLOWED_PATH.test(rel)) _refuse(REFUSAL.PATH_NOT_ALLOWED, 'refusing to publish outside the certification documents', { path: rel });
      const abs = path.join(ctx.dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      written.push(rel);
    }
    return written;
  }

  /**
   * Publish: compute changes against the remote's current tip, commit and
   * push, retrying from the new tip when someone else published first.
   * @param {function(function(string): (string|null)): (Object<string, string>|Promise<Object<string, string>>)} build - Given a reader of the remote's files, returns the files to write
   * @param {string} message - Commit message
   * @returns {Promise<{changed: boolean, commit: string|null}>} What was published
   */
  async function publish(build, message) {
    await ensureClone();
    for (let attempt = 1; ; attempt++) {
      await sync();
      const files = await build(readLocal);
      const written = writeFiles(files);
      if (written.length === 0) return { changed: false, commit: null };
      await must(['add', '--', ...written], 'add');
      const staged = await git(['diff', '--cached', '--quiet'], { cwd: ctx.dir, env });
      if (staged.code === 0) return { changed: false, commit: null };
      await must(['commit', '-q', '-m', message], 'commit');
      const pushed = await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: ctx.dir, env });
      if (pushed.code === 0) return { changed: true, commit: (await must(['rev-parse', 'HEAD'], 'rev-parse')).trim() };
      if (!_rejectedAsBehind(pushed.stderr) || attempt >= PUSH_ATTEMPTS) {
        _refuse(REFUSAL.PUBLISH_FAILED, 'the metrics branch did not accept the publish', { step: 'push', attempts: attempt });
      }
      await sleep(BACKOFF_MS * attempt);
    }
  }

  /**
   * Read a file as the remote holds it now, fetched fresh: the read-back that
   * proves a publish landed.
   * @param {string} rel - Repository-relative path
   * @returns {Promise<string|null>} Contents, or null when absent
   */
  async function read(rel) {
    await ensureClone();
    const exists = await sync();
    return exists ? readLocal(rel) : null;
  }

  return { publish, read };
}

/**
 * Where and as whom a candidate's scorecard is published: the worktree's
 * `origin` and the operator's configured git identity. Commits on the public
 * branch carry the operator's own name, never an invented one.
 * @param {string} worktreePath - Candidate worktree
 * @param {function} [git] - `runGit` seam
 * @returns {Promise<{remoteUrl: string, identity: {name: string, email: string}}>} Facts
 */
async function repoFacts(worktreePath, git = runGit) {
  const read = async (args, what) => {
    const r = await git(args, { cwd: worktreePath, env: {} });
    const v = r.stdout.trim();
    if (r.code !== 0 || !v) _refuse(REFUSAL.PUBLISH_FAILED, `could not read the worktree's ${what}`, { step: what });
    return v;
  };
  return {
    remoteUrl: await read(['remote', 'get-url', 'origin'], 'origin'),
    identity: { name: await read(['config', 'user.name'], 'user.name'), email: await read(['config', 'user.email'], 'user.email') }
  };
}

module.exports = { DEFAULT_BRANCH, ALLOWED_PATH, PUSH_ATTEMPTS, runGit, createPublisher, repoFacts };
