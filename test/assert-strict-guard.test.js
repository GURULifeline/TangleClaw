'use strict';

/**
 * The check that every test file uses strict assertions (#1377).
 *
 * The line it looks for is BUILT at runtime in this file and never typed. A
 * fixture carrying it literally would be a test file requiring the bare module,
 * so the check would fail its own repository, and a check excused from its own
 * scan is one nobody can trust.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = require('../scripts/assert-strict-guard');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'assert-strict-guard.js');
/** The module name, in two pieces. */
const BARE = ['node:', 'assert'].join('');
/** A bare require in the given quote style and spacing. */
const bare = (quote = "'", pad = '') => `const assert = require${pad}(${pad}${quote}${BARE}${quote}${pad});`;
const STRICT = `const assert = require('${BARE}/strict');`;
const WAIVER = `// prawduct:allow ${guard.WAIVER_REF} --`;

describe('assert-strict-guard (#1377)', () => {
  let root;
  /** Write files under a fresh directory and return it. */
  const tree = (files) => {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, 'test', name)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'test', name), `'use strict';\n${text}\n`);
    }
    return path.join(dir, 'test');
  };
  const offendersIn = (files) => guard.scan(tree(files)).offenders;

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-assert-strict-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('this repository has no test file that requires the bare module, at any depth', () => {
    const result = guard.scan(path.join(__dirname));
    assert.deepEqual(result.offenders, [], guard.report(result));
    // It read the directory rather than a list: this file is among what it read, and so is every other.
    const here = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')).length;
    assert.ok(result.scanned >= here && here > 500, `${result.scanned} scanned, ${here} here`);
    assert.ok(guard.testFiles(__dirname).includes(__filename));
  });

  it('finds a bare require in either quote style, with a formatter\'s spacing, in a nested directory, and names each file', () => {
    const dir = tree({
      'single.test.js': bare("'"),
      'double.test.js': bare('"'),
      'spaced.test.js': bare("'", ' '),
      'unprefixed.test.js': bare().replace('node:', ''),
      'deep/er/nested.test.js': `const fs = require('node:fs');\n\n${bare('"', '\t')}`,
      'fine.test.js': STRICT
    });
    const result = guard.scan(dir);
    assert.equal(result.scanned, 6);
    assert.deepEqual(result.offenders, [
      { file: 'test/deep/er/nested.test.js', line: 4 },
      { file: 'test/double.test.js', line: 2 },
      { file: 'test/single.test.js', line: 2 },
      { file: 'test/spaced.test.js', line: 2 },
      { file: 'test/unprefixed.test.js', line: 2 }
    ]);
    assert.ok(!bare().replace('node:', '').includes('node:'), 'the same module by its other name');
    const said = guard.report(result);
    for (const o of result.offenders) assert.ok(said.includes(`${o.file}:${o.line}  requires bare ${BARE}; use ${guard.REMEDY}`), o.file);
    assert.match(said, /5 of 6 test file\(s\) checked/);
    assert.equal(guard.REMEDY, `require('${BARE}/strict')`);
  });

  it('as a command: exits 1 on an offender, naming it and the remedy, and 0 on a clean tree', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, tree({ 'left-behind.test.js': bare() })], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /test\/left-behind\.test\.js:2 {2}requires bare /);
    assert.ok(bad.stderr.includes(guard.REMEDY));
    assert.equal(bad.stdout, '');
    const good = spawnSync(process.execPath, [SCRIPT, tree({ 'ok.test.js': STRICT })], { encoding: 'utf8' });
    assert.deepEqual([good.status, good.stderr], [0, '']);
    assert.match(good.stdout, /1 test file\(s\), none requires bare /);
    // With no argument it checks this repository's own tests.
    const own = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(own.status, 0, own.stderr);
    const counted = /^assert-strict-guard: (\d+) test file\(s\), none requires bare /m.exec(own.stdout);
    assert.ok(counted && Number(counted[1]) === guard.scan(__dirname).scanned && Number(counted[1]) > 500, own.stdout);
  });

  it('reads only test files, and leaves what is installed alone', () => {
    assert.deepEqual(offendersIn({
      'helper.js': bare(),
      '_shared.js': bare(),
      'notes.test.js.bak': bare(),
      'node_modules/dep/x.test.js': bare()
    }), []);
  });

  it('does not take the strict module, a longer name, or a comment for the bare one', () => {
    assert.deepEqual(offendersIn({
      'strict.test.js': STRICT,
      'other.test.js': `const a = require('${BARE}ions');\nconst b = require('${BARE}/strict');\nconst c = require('assert/strict');\nconst d = require('assertion');`,
      'line-comment.test.js': `${STRICT}\n// was: ${bare()}`,
      'block-comment.test.js': `/**\n * Once: ${bare()}\n */\n${STRICT}\n/* ${bare()} */`
    }), []);
    // Code before a comment on the same line is still code, and so is code after a block comment that has closed.
    assert.deepEqual(offendersIn({
      'trailing.test.js': `${bare()} // the old way`,
      'after-closed-block.test.js': `/* loose on purpose */ ${bare()}`,
      'after-closed-body.test.js': `/*\n * why\n */ ${bare()}`
    }), [
      { file: 'test/after-closed-block.test.js', line: 2 },
      { file: 'test/after-closed-body.test.js', line: 4 },
      { file: 'test/trailing.test.js', line: 2 }
    ]);
  });

  it('an exception is written on the line or the one above it, with a reason, and is reported as waived', () => {
    const dir = tree({
      'trailing.test.js': `${bare()} ${WAIVER} compares against a legacy loose fixture`,
      'leading.test.js': `${WAIVER} the suite under test documents loose equality\n${bare('"')}`,
      'several.test.js': `${bare()} // prawduct:allow prawduct/broad-except, ${guard.WAIVER_REF} -- two rules, one line`
    });
    const result = guard.scan(dir);
    assert.deepEqual(result.offenders, []);
    assert.deepEqual(result.waived, [
      { file: 'test/leading.test.js', line: 3, reason: 'the suite under test documents loose equality' },
      { file: 'test/several.test.js', line: 2, reason: 'two rules, one line' },
      { file: 'test/trailing.test.js', line: 2, reason: 'compares against a legacy loose fixture' }
    ]);
    assert.match(guard.report(result), /^waived {2}test\/leading\.test\.js:3 {2}the suite under test documents loose equality$/m);
  });

  it('a waiver with no reason, for another rule, or too far away waives nothing', () => {
    assert.deepEqual(offendersIn({
      'no-reason.test.js': `${bare()} ${WAIVER}`,
      'blank-reason.test.js': `${bare()} ${WAIVER}   `,
      'other-rule.test.js': `${bare()} // prawduct:allow prawduct/broad-except -- not this rule`,
      'other-project-rule.test.js': `${bare()} // prawduct:allow ${guard.WAIVER_REF}-ish -- a longer id is another rule`,
      'two-above.test.js': `${WAIVER} too far away\n\n${bare()}`,
      'below.test.js': `${bare()}\n${WAIVER} a waiver does not reach upward`
    }).map((o) => o.file), [
      'test/below.test.js', 'test/blank-reason.test.js', 'test/no-reason.test.js',
      'test/other-project-rule.test.js', 'test/other-rule.test.js', 'test/two-above.test.js'
    ]);
  });
});
