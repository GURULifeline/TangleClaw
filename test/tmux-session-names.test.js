'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tmux = require('../lib/tmux');
const { uniqueSessionName } = require('./_tmux-session-names');

const HELPER = path.join(__dirname, '_tmux-session-names.js');

/**
 * Ask a separate node process for names under one label.
 * @param {string} label - The label to pass
 * @param {number} count - How many names to ask for
 * @returns {string[]} The names that process was given
 */
function namesFromAnotherProcess(label, count) {
  const script = `const { uniqueSessionName } = require(${JSON.stringify(HELPER)});` +
    `const out = []; for (let i = 0; i < ${count}; i++) out.push(uniqueSessionName(${JSON.stringify(label)}));` +
    'process.stdout.write(JSON.stringify(out));';
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
}

describe('uniqueSessionName — names for real tmux sessions in tests (#1983)', () => {
  it('never repeats a name within one process, even under the same label', () => {
    const names = Array.from({ length: 200 }, () => uniqueSessionName('same'));
    assert.equal(new Set(names).size, names.length);
  });

  it('gives two processes disjoint names for the same label', () => {
    // The defect was two suite runs sharing a literal name. Two real processes
    // asking under one label is that situation, minus tmux.
    const a = namesFromAnotherProcess('shared', 20);
    const b = namesFromAnotherProcess('shared', 20);
    const mine = Array.from({ length: 20 }, () => uniqueSessionName('shared'));
    const all = [...a, ...b, ...mine];
    assert.equal(new Set(all).size, all.length, 'no name may appear in two processes');
  });

  it('does not rest on the pid alone', () => {
    // A pid is unique only inside one pid namespace, and containers can share a
    // tmux socket. Strip the pid and the counter: what is left must still tell
    // two processes apart.
    const strip = (name) => name.replace(/_\d+_([0-9a-f]+)_\d+__$/, '_$1');
    const a = strip(namesFromAnotherProcess('ns', 1)[0]);
    const b = strip(namesFromAnotherProcess('ns', 1)[0]);
    assert.notEqual(a, b, 'the per-process nonce must differ between processes');
  });

  it('produces names lib/tmux accepts, with the label readable in them', () => {
    const name = uniqueSessionName('readable-label_1');
    assert.equal(tmux.isValidSessionName(name), true);
    assert.ok(name.includes('readable-label_1'));
    assert.ok(name.startsWith('__tc_test_'), 'a fixture must be recognisable in `tmux ls`');
  });

  it('keeps a derived longer name valid, for the prefix-targeting tests', () => {
    const base = uniqueSessionName('prefix');
    const longer = `${base}-neighbour`;
    assert.equal(tmux.isValidSessionName(longer), true);
    assert.ok(longer.startsWith(base) && longer !== base);
  });

  it('refuses a label tmux would reject or rewrite', () => {
    for (const bad of ['', 'a b', 'a.b', 'a:b', "a'b", null, undefined, 7]) {
      assert.throws(() => uniqueSessionName(bad), /label must be/);
    }
  });
});

describe('no test creates a real tmux session under a fixed name (#1983)', () => {
  /**
   * Remove comments, so prose that quotes a name is not read as code.
   * @param {string} src - JavaScript source
   * @returns {string} The source without block or line comments
   */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  // The files that start a real tmux session. A new one belongs in this list;
  // the scan below is what finds it.
  const REAL_SESSION_FILES = ['activity-observer.test.js', 'tmux-draft-capture.test.js', 'tmux.test.js'];

  /** Matches a call that starts a real session: the lib helper, or tmux itself. */
  const STARTS_REAL_SESSION = /\btmux\.createSession\(|['"`]new-session['"`]\s*,/;

  it('knows every test file that starts one', () => {
    // `tmux.createSession` is stubbed or poisoned in most suites (#902), so only
    // files that call it for real, or spawn `tmux new-session` themselves, count.
    const found = fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.test.js') && f !== path.basename(__filename))
      .filter((f) => {
        const src = stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'));
        if (!STARTS_REAL_SESSION.test(src)) return false;
        // Suites that install the guard cannot reach the real createSession, and
        // the guard's own test calls it only to watch it throw.
        return !/installTmuxGuard\(/.test(src);
      })
      .sort();
    assert.deepEqual(found, REAL_SESSION_FILES,
      'a test file that starts a real tmux session must be listed here and take its names from uniqueSessionName');
  });

  for (const file of REAL_SESSION_FILES) {
    it(`${file} takes its session names from the factory`, () => {
      const src = stripComments(fs.readFileSync(path.join(__dirname, file), 'utf8'));
      assert.match(src, /require\('\.\/_tmux-session-names'\)/);
      // THE MUTATION THIS CATCHES: a session name written as a literal again.
      // Names that are only ever probed for absence are spelled `__nonexistent_`
      // or `__never_existed_` and are not sessions.
      const literals = src.match(/['"`]__tc_test_[^'"`]*['"`]/g) || [];
      assert.deepEqual(literals, [], `${file} names a real session with a literal`);
      assert.doesNotMatch(src, /`tc-[a-z0-9-]+-\$\{process\.pid\}`/,
        `${file} builds a session name from the pid alone`);
    });
  }
});
