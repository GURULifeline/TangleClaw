'use strict';

/*
 * #1930 — roadmap train cards on served plan pages. A plan is session-authored
 * and served on the dashboard origin, so the contract is the escaping and the
 * closed schema: asserted on rendered OUTPUT through renderPlanBody, the path a
 * reader actually gets.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const planDocs = require('../lib/plan-docs');
const trainCard = require('../lib/plan-train-card');

const REPO = 'https://github.com/Jason-Vaughan/TangleClaw';

/**
 * A valid train, with overrides.
 * @param {object} [over] - Fields to replace.
 * @returns {object}
 */
function train(over = {}) {
  return {
    train: 1,
    title: 'First Install, Completed',
    href: `${REPO}/milestone/5`,
    verified: true,
    thesis: 'The rest of the **first** hour.',
    cars: [
      { issue: 411, closed: false, href: `${REPO}/issues/411`, type: 'bug', title: 'Stale service worker' },
      { issue: 1234, closed: true, href: `${REPO}/issues/1234`, type: 'enhancement', title: 'Done thing' }
    ],
    sequencing: 'Do `A` first.',
    ...over
  };
}

/**
 * Render one block through the plan renderer.
 * @param {object|string} body - Train object, or raw block text.
 * @param {string} [fence] - Fence marker.
 * @returns {string}
 */
function render(body, fence = '```') {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return planDocs.renderPlanBody(`${fence}tc-train\n${text}\n${fence}`);
}

/**
 * Assert a block is refused: code fallback plus a reason matching `why`.
 * @param {object|string} body - Block.
 * @param {RegExp} why - Expected reason.
 * @returns {string} The HTML.
 */
function refused(body, why) {
  const html = render(body);
  assert.doesNotMatch(html, /class="train-card"/);
  assert.match(html, /<p class="block-error">Train block not rendered: /);
  assert.match(html, /<pre><code class="language-tc-train">/);
  assert.match(html, why);
  return html;
}

describe('plan train cards (#1930)', () => {
  describe('a valid block', () => {
    const html = render(train());

    it('renders a collapsible card whose summary is the engine, the cars, the name, the count and the badge', () => {
      assert.match(html, /^<details class="train-card"><summary class="train-summary"><span class="train-engine" aria-hidden="true">🚂<\/span>/);
      assert.match(html, /<span class="train-car open" title="#411 open" aria-label="#411 open">#411<\/span><span class="train-joint" aria-hidden="true">—<\/span><span class="train-car closed" title="#1234 closed" aria-label="#1234 closed">#1234<\/span>/);
      assert.match(html, /<span class="train-name">Train 1: First Install, Completed<\/span><span class="train-count">\(1\/2\)<\/span><span class="train-badge">verified<\/span><\/summary>/);
    });

    it('expands to the thesis, the open/closed line with the milestone link, the issue table and the sequencing note', () => {
      assert.match(html, /<p><em>The rest of the <strong>first<\/strong> hour\.<\/em><\/p>/);
      assert.match(html, /<p><strong>1 open · 1 closed<\/strong> · <a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/milestone\/5">milestone<\/a><\/p>/);
      assert.match(html, /<td class="train-issue"><a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/411">#411<\/a><\/td><td>bug<\/td><td class="train-state">open<\/td><td>Stale service worker<\/td>/);
      assert.match(html, /<td class="train-issue"><a [^>]*>#1234<\/a><\/td><td>enhancement<\/td><td class="train-state">✅ closed<\/td><td>Done thing<\/td>/);
      // Green means done: a closed issue's title is not struck through.
      assert.doesNotMatch(html, /<del>/);
      assert.match(html, /<p><strong>Sequencing\.<\/strong> Do <code>A<\/code> first\.<\/p><\/div><\/details>$/);
    });

    it('omits the badge unless verified is true, and computes the count from the cars', () => {
      const plain = render(train({ verified: false, cars: [{ issue: 1, closed: true }, { issue: 2, closed: true }, { issue: 3, closed: false }] }));
      assert.doesNotMatch(plain, /train-badge/);
      assert.match(plain, /<span class="train-count">\(2\/3\)<\/span>/);
      assert.match(plain, /<strong>1 open · 2 closed<\/strong>/);
      assert.doesNotMatch(render(train({ verified: undefined })), /train-badge/);
    });

    it('renders a train with no cars as an engine alone and a placeholder row', () => {
      const empty = render(train({ cars: [] }));
      assert.match(empty, /🚂<\/span><span class="train-name">/);
      assert.match(empty, /\(0\/0\)/);
      assert.match(empty, /No issues assigned\./);
    });

    it('accepts a tilde fence as well as a backtick fence', () => {
      assert.match(render(train(), '~~~'), /class="train-card"/);
    });

    it('leaves every other fenced block as code', () => {
      const html = planDocs.renderPlanBody('```json\n{"train":1}\n```');
      assert.equal(html, '<pre><code class="language-json">{&quot;train&quot;:1}</code></pre>');
    });
  });

  describe('escaping — nothing in the block becomes markup', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';

    it('escapes the title, the car type and title, and the thesis and sequencing', () => {
      const html = render(train({
        title: evil, thesis: evil, sequencing: evil,
        cars: [{ issue: 1, closed: false, type: evil.slice(0, 40), title: evil }]
      }));
      assert.doesNotMatch(html, /<script|<img/);
      assert.match(html, /Train 1: &lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
    });

    it('escapes a quote inside an accepted href so it cannot leave the attribute', () => {
      const html = render(train({ href: 'https://example.com/a"onmouseover="alert(1)' }));
      assert.match(html, /<a href="https:\/\/example\.com\/a&quot;onmouseover=&quot;alert\(1\)">milestone<\/a>/);
    });

    it('does not echo a refused value into the reason', () => {
      const html = refused({ ...train(), '<b>x</b>': 1 }, /unknown key &quot;&lt;b&gt;x&lt;\/b&gt;&quot;/);
      assert.doesNotMatch(html, /<b>/);
    });
  });

  describe('hrefs — only absolute https URLs', () => {
    for (const bad of [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://example.com/',
      '//evil.example/x', '/\\evil.example', 'https:\\\\evil.example', '/relative', 'relative.md',
      '\u0001javascript:alert(1)', 'https://exa mple.com', 'https:///x', ''
    ]) {
      it(`refuses ${JSON.stringify(bad)} on the train and on a car`, () => {
        refused(train({ href: bad }), /href must be an absolute https URL|href must be a string/);
        refused(train({ cars: [{ issue: 1, closed: false, href: bad }] }), /cars\[0\]\.href must be an absolute https URL/);
      });
    }

    it('renders a car with no href as plain text in the table', () => {
      assert.match(render(train({ cars: [{ issue: 7, closed: false }] })), /<td class="train-issue">#7<\/td><td>—<\/td><td class="train-state">open<\/td><td><\/td>/);
    });
  });

  describe('the schema is closed', () => {
    it('refuses non-JSON, arrays, null and scalars', () => {
      refused('{not json', /block is not valid JSON/);
      refused('[1,2]', /block must be a JSON object/);
      refused('null', /block must be a JSON object/);
      refused('"x"', /block must be a JSON object/);
    });

    it('refuses an unknown key, including __proto__, at the top and on a car', () => {
      refused({ ...train(), style: 'x' }, /unknown key &quot;style&quot;/);
      refused('{"train":1,"title":"t","cars":[],"__proto__":{"x":1}}', /unknown key &quot;__proto__&quot;/);
      refused(train({ cars: [{ issue: 1, closed: false, html: '<b>' }] }), /cars\[0\] has unknown key &quot;html&quot;/);
    });

    it('refuses a missing or mistyped required field', () => {
      refused(train({ train: undefined }), /train must be an integer/);
      refused(train({ train: 0 }), /train must be an integer/);
      refused(train({ train: 1.555 }), /train must be an integer/);
      refused(train({ train: '1' }), /train must be an integer/);
      refused(train({ train: trainCard.LIMITS.train + 1 }), /train must be an integer/);
      refused(train({ title: '  ' }), /title must be a non-empty string/);
      refused(train({ title: 7 }), /title must be a non-empty string/);
      refused(train({ cars: 'x' }), /cars must be an array/);
      refused(train({ cars: undefined }), /cars must be an array/);
      refused(train({ verified: 'yes' }), /verified must be true or false/);
      refused(train({ thesis: 3 }), /thesis must be a string/);
    });

    it('refuses a malformed car', () => {
      refused(train({ cars: [null] }), /cars\[0\] must be an object/);
      refused(train({ cars: [[1]] }), /cars\[0\] must be an object/);
      refused(train({ cars: [{ issue: -1, closed: false }] }), /cars\[0\]\.issue must be a positive integer/);
      refused(train({ cars: [{ issue: '5', closed: false }] }), /cars\[0\]\.issue must be a positive integer/);
      refused(train({ cars: [{ issue: 5 }] }), /cars\[0\]\.closed must be true or false/);
      refused(train({ cars: [{ issue: 5, closed: false, type: 'x'.repeat(41) }] }), /cars\[0\]\.type is longer than 40 characters/);
    });

    it('enforces the size bounds', () => {
      refused(train({ title: 'x'.repeat(trainCard.LIMITS.title + 1) }), /title is longer than 200 characters/);
      refused(train({ cars: Array.from({ length: trainCard.LIMITS.cars + 1 }, (_, i) => ({ issue: i + 1, closed: false })) }), /cars has more than 500 entries/);
      refused(' '.repeat(trainCard.LIMITS.body + 1), /block is larger than 200000 characters/);
      assert.match(render(train({ title: 'x'.repeat(trainCard.LIMITS.title) })), /class="train-card"/);
    });
  });

  describe('page styles', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 74, name: 'Roadmap' }, file: 'b.md', relative: '.tangleclaw/plans/b.md',
      modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '# B', timeZone: 'UTC'
    });

    it('keeps table cells from breaking a word, so an issue number never wraps', () => {
      assert.match(page, /main\.plan th,main\.plan td\{[^}]*overflow-wrap:normal[^}]*\}/);
      assert.match(page, /td\.train-issue,td\.train-state\{white-space:nowrap\}/);
      assert.match(page, /\.train-car\{[^}]*white-space:nowrap/);
    });

    it('colors a closed car green and an open car in the theme surface', () => {
      assert.match(page, /\.train-car\.closed\{background:#238636;border-color:#238636;color:#fff\}/);
      assert.match(page, /\.train-car\{[^}]*background:var\(--code-bg\)/);
    });
  });
});

describe('train version, status and car state (#1933)', () => {
  it('shows an escaped version badge and a status badge after the count', () => {
    const html = render(train({ version: 'v6', status: 'in-progress' }));
    assert.match(html, /<span class="train-count">\(1\/2\)<\/span><span class="train-version">v6<\/span><span class="train-status status-in-progress">in progress<\/span><span class="train-badge">verified<\/span>/);
  });

  it('renders every status in the closed enum, and omits both badges when absent', () => {
    for (const status of trainCard.TRAIN_STATUSES) {
      assert.match(render(train({ status })), new RegExp(`<span class="train-status status-${status}">${status.replace('-', ' ')}</span>`));
    }
    assert.doesNotMatch(render(train()), /train-version|train-status/);
  });

  it('refuses a status outside the enum and a malformed version', () => {
    refused(train({ status: 'done' }), /status must be one of planned, ready, in-progress, blocked, shipped, sunset/);
    refused(train({ status: '<b>' }), /status must be one of/);
    refused(train({ version: '' }), /version must start with a letter or digit/);
    refused(train({ version: '-v6' }), /version must start with a letter or digit/);
    refused(train({ version: 'v6<script>' }), /version must start with a letter or digit/);
    refused(train({ version: 'v'.repeat(17) }), /version is longer than 16 characters/);
    refused(train({ version: 6 }), /version must be a string/);
    assert.match(render(train({ version: '5.30 beta_1' })), /<span class="train-version">5\.30 beta_1<\/span>/);
  });

  it('colours a car by its state, labels it in words, and says the state in the table', () => {
    const html = render(train({
      cars: [
        { issue: 1, closed: false, state: 'in-progress' },
        { issue: 2, closed: false, state: 'blocked' },
        { issue: 3, closed: false, state: 'open' },
        { issue: 4, closed: true, state: 'closed' }
      ]
    }));
    assert.match(html, /<span class="train-car in-progress" title="#1 in progress" aria-label="#1 in progress">#1<\/span>/);
    assert.match(html, /<span class="train-car blocked" title="#2 blocked" aria-label="#2 blocked">#2<\/span>/);
    assert.match(html, /<span class="train-car open" title="#3 open" aria-label="#3 open">#3<\/span>/);
    assert.match(html, /<span class="train-car closed" title="#4 closed" aria-label="#4 closed">#4<\/span>/);
    assert.match(html, /<td class="train-state">◐ in progress<\/td>/);
    assert.match(html, /<td class="train-state">⛔ blocked<\/td>/);
    assert.match(html, /\(1\/4\)/);
    assert.match(html, /<strong>3 open \(1 in progress, 1 blocked\) · 1 closed<\/strong>/);
  });

  it('keeps the old behaviour when a car has no state', () => {
    const html = render(train({ cars: [{ issue: 5, closed: false }, { issue: 6, closed: true }] }));
    assert.match(html, /train-car open" title="#5 open"/);
    assert.match(html, /train-car closed" title="#6 closed"/);
    assert.match(html, /<strong>1 open · 1 closed<\/strong>/);
  });

  it('refuses a state outside the enum, or one that disagrees with closed', () => {
    refused(train({ cars: [{ issue: 1, closed: false, state: 'done' }] }), /cars\[0\]\.state must be one of open, in-progress, blocked, closed/);
    refused(train({ cars: [{ issue: 1, closed: true, state: 'in-progress' }] }), /cars\[0\]\.state must agree with closed/);
    refused(train({ cars: [{ issue: 1, closed: false, state: 'closed' }] }), /cars\[0\]\.state must agree with closed/);
  });

  it('colours in-progress amber, blocked red and a new queue issue blue', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
    });
    assert.match(page, /\.train-car\.in-progress\{background:#9a6700;border-color:#9a6700;color:#fff\}/);
    assert.match(page, /\.train-car\.blocked\{background:#cf222e;border-color:#cf222e;color:#fff\}/);
    assert.match(page, /\.train-car\.queue-new\{background:#0969da;border-color:#0969da;color:#fff\}/);
  });

  it('lightens the coloured status badges in dark mode so small text stays legible', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
    });
    assert.match(page, /@media \(prefers-color-scheme:dark\)\{\.train-status\.status-in-progress\{border-color:#d29922;color:#d29922\}\.train-status\.status-blocked\{border-color:#f85149;color:#f85149\}\.train-status\.status-shipped\{border-color:#3fb950;color:#3fb950\}\}/);
  });
});

describe('the new cards queue (#1933)', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z');
  const Q = 'https://github.com/Jason-Vaughan/TangleClaw/issues';

  /**
   * A valid queue, with overrides.
   * @param {object} [over] - Fields to replace.
   * @returns {object}
   */
  function queue(over = {}) {
    return {
      newDays: 14,
      issues: [
        { issue: 100, title: 'Old untriaged', href: `${Q}/100`, type: 'bug', labels: ['needs-triage'], createdAt: '2026-06-01T09:00:00Z' },
        { issue: 1932, title: 'Fresh one', href: `${Q}/1932`, type: 'enhancement', createdAt: '2026-09-27T09:30:00Z' },
        { issue: 1900, title: 'Last week', createdAt: '2026-09-20T12:00:00Z' }
      ],
      ...over
    };
  }

  /**
   * Render a queue block through the plan renderer at a fixed time.
   * @param {object|string} body - Queue object, or raw block text.
   * @returns {string}
   */
  function renderQ(body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return planDocs.renderPlanBody(`\`\`\`tc-queue\n${text}\n\`\`\``, 0, { now: NOW });
  }

  /**
   * Assert a queue block is refused with a reason matching `why`.
   * @param {object|string} body - Block.
   * @param {RegExp} why - Expected reason.
   * @returns {void}
   */
  function refusedQ(body, why) {
    const html = renderQ(body);
    assert.doesNotMatch(html, /class="train-card/);
    assert.match(html, /<p class="block-error">Queue block not rendered: /);
    assert.match(html, /<pre><code class="language-tc-queue">/);
    assert.match(html, why);
  }

  it('shows the new issues as pills in the summary, with the new and waiting counts', () => {
    const html = renderQ(queue());
    assert.match(html, /^<details class="train-card queue-card"><summary class="train-summary"><span class="train-engine" aria-hidden="true">📥<\/span>/);
    assert.match(html, /<span class="train-car queue-new" title="#1932 new" aria-label="#1932 new">#1932<\/span><span class="train-car queue-new" title="#1900 new" aria-label="#1900 new">#1900<\/span><span class="train-name">New cards queue<\/span>/);
    assert.match(html, /<span class="train-count">\(2 new · 3 waiting\)<\/span>/);
    assert.doesNotMatch(html, /title="#100 new"/);
  });

  it('lists every waiting issue newest first, and age never removes an old one', () => {
    const html = renderQ(queue());
    const order = [...html.matchAll(/<td class="train-issue">(?:<a [^>]*>)?#(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(order, [1932, 1900, 100]);
    assert.match(html, /<td class="train-issue"><a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/100">#100<\/a><\/td><td>bug<\/td><td><code>needs-triage<\/code><\/td><td class="train-state">118d<\/td><td>Old untriaged<\/td>/);
  });

  it('marks new rows and computes ages in hours and days from the render time', () => {
    const html = renderQ(queue());
    assert.match(html, /<td class="train-state">2h <span class="queue-new-badge">new<\/span><\/td><td>Fresh one<\/td>/);
    assert.match(html, /<td class="train-state">7d <span class="queue-new-badge">new<\/span><\/td><td>Last week<\/td>/);
  });

  it('marks new by the threshold, inclusive, and reads a future timestamp as under an hour', () => {
    const edge = renderQ(queue({ newDays: 7, issues: [{ issue: 1, createdAt: '2026-09-20T12:00:00Z' }, { issue: 2, createdAt: '2026-09-20T11:59:59Z' }] }));
    assert.match(edge, /title="#1 new"/);
    assert.doesNotMatch(edge, /title="#2 new"/);
    const skew = renderQ(queue({ issues: [{ issue: 3, createdAt: '2026-09-27T13:00:00Z' }] }));
    assert.match(skew, /<td class="train-state">&lt;1h <span class="queue-new-badge">new<\/span><\/td>/);
  });

  it('uses a custom title, escaped, and renders an empty queue', () => {
    assert.match(renderQ(queue({ title: 'Inbox <b>' })), /<span class="train-name">Inbox &lt;b&gt;<\/span>/);
    const empty = renderQ(queue({ issues: [] }));
    assert.match(empty, /\(0 new · 0 waiting\)/);
    assert.match(empty, /Nothing waiting\./);
  });

  it('escapes titles, types and labels', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderQ(queue({ issues: [{ issue: 1, title: evil, type: '<b>', labels: ['<i>'], createdAt: '2026-09-27T00:00:00Z' }] }));
    assert.doesNotMatch(html, /<img|<b>|<i>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('computes the age at render time, so the same block ages as time passes', () => {
    const body = '```tc-queue\n' + JSON.stringify(queue()) + '\n```';
    assert.match(planDocs.renderPlanBody(body, 0, { now: NOW + 30 * 86400000 }), /\(0 new · 3 waiting\)/);
    const page = planDocs.renderPlanPage({
      project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z',
      markdown: body, timeZone: 'UTC', now: NOW
    });
    assert.match(page, /\(2 new · 3 waiting\)/);
  });

  it('refuses a malformed queue', () => {
    refusedQ('nope', /block is not valid JSON/);
    refusedQ({ ...queue(), extra: 1 }, /unknown key &quot;extra&quot;/);
    refusedQ(queue({ newDays: 0 }), /newDays must be an integer from 1 to 365/);
    refusedQ(queue({ newDays: '14' }), /newDays must be an integer/);
    refusedQ(queue({ issues: 'x' }), /issues must be an array/);
    refusedQ(queue({ issues: [{ issue: 1 }] }), /issues\[0\]\.createdAt must be an ISO-8601 timestamp with a zone/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27' }] }), /createdAt must be an ISO-8601/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-13-45T99:99:00Z' }] }), /createdAt must be an ISO-8601/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', state: 'x' }] }), /issues\[0\] has unknown key &quot;state&quot;/);
    refusedQ(queue({ issues: [{ issue: 0, createdAt: '2026-09-27T00:00:00Z' }] }), /issues\[0\]\.issue must be a positive integer/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', href: 'javascript:alert(1)' }] }), /issues\[0\]\.href must be an absolute https URL/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', labels: 'bug' }] }), /issues\[0\]\.labels must be an array/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', labels: [''] }] }), /labels\[0\] must be a string of 1 to 40 characters/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', labels: Array(11).fill('a') }] }), /labels has more than 10 entries/);
    refusedQ(queue({ issues: Array.from({ length: trainCard.LIMITS.queueIssues + 1 }, (_, i) => ({ issue: i + 1, createdAt: '2026-09-27T00:00:00Z' })) }), /issues has more than 1000 entries/);
  });
});

describe('permanent train identities and card kinds (#1942)', () => {
  /**
   * The text of a rendered card's name.
   * @param {object} over - Fields to replace on the valid train.
   * @returns {string}
   */
  function nameOf(over) {
    const html = render(train(over));
    assert.match(html, /class="train-card"/, 'the block must render as a card');
    return html.match(/<span class="train-name">([^<]*)<\/span>/)[1];
  }

  it('prints the identity it is given, never a position', () => {
    assert.equal(nameOf({ train: 16, title: 'Secure Surface' }), 'Train 16: Secure Surface');
    assert.equal(nameOf({ train: 13.5, title: 'Half Step' }), 'Train 13.5: Half Step');
    assert.equal(nameOf({ train: 'A', title: 'Version 5 Bridge Train A' }), 'Train A: Version 5 Bridge Train A');
    assert.equal(nameOf({ train: 'C-E', title: 'Later trains' }), 'Train C-E: Later trains');
  });

  it('names a Pilot as what it is, not as a train', () => {
    assert.equal(nameOf({ kind: 'pilot', train: 'B2', title: 'Pilot lane' }), 'Pilot B2: Pilot lane');
    assert.equal(nameOf({ kind: 'pilot', train: 'B2', title: 'B2' }), 'Pilot: B2', 'an identity equal to the title is not printed twice');
    assert.doesNotMatch(render(train({ kind: 'pilot', train: 'B2', title: 'T' })), />Train /);
  });

  it('renders an unconfigured milestone with no identity, and refuses one that carries an identity', () => {
    assert.equal(nameOf({ kind: 'unconfigured', train: undefined, title: 'New milestone' }), 'Unconfigured: New milestone');
    refused(train({ kind: 'unconfigured', train: 3 }), /train must be absent when kind is unconfigured/);
  });

  it('keeps a block without kind reading as a train, as before', () => {
    assert.equal(nameOf({ train: 1 }), 'Train 1: First Install, Completed');
    assert.equal(nameOf({ kind: 'train', train: 1 }), 'Train 1: First Install, Completed');
  });

  it('refuses an identity every other kind needs, and a kind outside the enum', () => {
    for (const kind of ['train', 'pilot']) {
      refused(train({ kind, train: undefined }), /train must be an integer/);
    }
    refused(train({ kind: 'epic' }), /kind must be one of train, bucket, pilot, unconfigured/);
    refused(train({ kind: 7 }), /kind must be one of/);
  });

  it('accepts only canonical identities', () => {
    // A number is written as a JSON number, so "16" and 16 cannot both name one train.
    refused(train({ train: '16' }), /train must be an integer/);
    refused(train({ train: '13.5' }), /train must be an integer/);
    refused(train({ train: 13.555 }), /train must be an integer/);
    refused(train({ train: 0.5 }), /train must be an integer/);
    refused(train({ train: -2 }), /train must be an integer/);
    refused(train({ train: '' }), /train must be an integer/);
    refused(train({ train: ' A' }), /train must be an integer/);
    refused(train({ train: 'A ' }), /train must be an integer/);
    refused(train({ train: 'x'.repeat(trainCard.LIMITS.trainId + 1) }), /train must be an integer/);
    refused(train({ train: true }), /train must be an integer/);
    refused(train({ train: ['A'] }), /train must be an integer/);
    assert.match(render(train({ train: 'x'.repeat(trainCard.LIMITS.trainId) })), /class="train-card"/);
    assert.match(render(train({ train: trainCard.LIMITS.train })), /class="train-card"/);
  });

  it('never lets an identity become markup', () => {
    refused(train({ train: 'A<b>' }), /train must be an integer/);
    refused(train({ train: 'A"x' }), /train must be an integer/);
    const html = render(train({ kind: 'pilot', train: 'R&D', title: 'R&D' }));
    assert.match(html, /class="block-error"/, 'an ampersand is outside the identity alphabet');
    assert.doesNotMatch(html, /class="train-card"/);
  });
});

describe('ID-less Topic Buckets (#2006)', () => {
  /**
   * A bucket shaped like the shared roadmap's: no `train`, a milestone link
   * and open cars.
   * @param {object} [over] - Fields to replace.
   * @returns {object}
   */
  function bucket(over = {}) {
    return {
      kind: 'bucket',
      title: 'Infrastructure Hardening',
      href: `${REPO}/milestone/9`,
      verified: false,
      thesis: 'Non-train topic bucket.',
      cars: [
        { issue: 192, closed: false, state: 'open', href: `${REPO}/issues/192`, type: 'bug', title: 'Multi-line paste corrupts input' },
        { issue: 254, closed: false, state: 'open', href: `${REPO}/issues/254`, type: 'bug', title: 'Device re-pairing each launch' }
      ],
      ...over
    };
  }

  it('renders a bucket with no train as a collapsible card', () => {
    const html = render(bucket());
    assert.match(html, /<details class="train-card"/);
    assert.match(html, /<summary class="train-summary"/);
    assert.match(html, /aria-label="#192 open"/);
  });

  it('names it exactly "Topic Bucket: <title>", with no train number', () => {
    const html = render(bucket());
    assert.equal(html.match(/<span class="train-name">([^<]*)<\/span>/)[1], 'Topic Bucket: Infrastructure Hardening');
    assert.doesNotMatch(html, />Train /);
    assert.equal(trainCard.parseTrainBlock(JSON.stringify(bucket()), () => true).train, undefined,
      'the parser never assigns a bucket an identity');
  });

  it('refuses a bucket that carries a train identity', () => {
    for (const id of [3, 13.5, 'Infra', 'Infrastructure Hardening']) {
      refused(bucket({ train: id }), /train must be absent when kind is bucket/);
    }
  });

  it('renders every current roadmap bucket shape without a block error', () => {
    for (const title of ['Infrastructure Hardening', 'Master Control', 'Version 5 Subsequent (Trains C-E)']) {
      const html = render(bucket({ title }));
      assert.doesNotMatch(html, /block-error/, title);
      assert.doesNotMatch(html, /language-tc-train/, title);
      assert.match(html, /class="train-card"/, title);
    }
  });

  it('leaves train and pilot identity validation unchanged', () => {
    refused(train({ kind: 'train', train: undefined }), /train must be an integer/);
    refused(train({ kind: 'pilot', train: undefined }), /train must be an integer/);
    refused(train({ train: '16' }), /train must be an integer/);
    refused(train({ kind: 'unconfigured', train: 3 }), /train must be absent when kind is unconfigured/);
    assert.match(render(train({ kind: 'train', train: 16 })), /class="train-card"/);
    assert.match(render(train({ kind: 'pilot', train: 'B2' })), /class="train-card"/);
  });
});

describe('in-review and dropped cars, and the owning lane (#2165)', () => {
  /**
   * The plan page's stylesheet.
   * @returns {string}
   */
  const stylesheet = () => planDocs.renderPlanPage({
    project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
  });

  it('draws an in-review car and a dropped car with their own class, words and table cell', () => {
    const html = render(train({
      cars: [
        { issue: 1, closed: false, state: 'in-review' },
        { issue: 2, closed: true, state: 'dropped' }
      ]
    }));
    assert.match(html, /<span class="train-car in-review" title="#1 in review" aria-label="#1 in review">#1<\/span>/);
    assert.match(html, /<span class="train-car dropped" title="#2 dropped" aria-label="#2 dropped">#2<\/span>/);
    assert.match(html, /<td class="train-state">◆ in review<\/td>/);
    assert.match(html, /<td class="train-state">⊘ dropped<\/td>/);
  });

  it('colours in-review purple, and marks dropped with a line-through as well as a colour that is not green', () => {
    const page = stylesheet();
    assert.match(page, /\.train-car\.in-review\{background:#8250df;border-color:#8250df;color:#fff\}/);
    assert.match(page, /\.train-car\.dropped\{background:#57606a;border-color:#57606a;color:#fff;text-decoration:line-through\}/);
  });

  it('has words, a table cell and a style for every state in the enum', () => {
    const page = stylesheet();
    const html = render(train({
      cars: trainCard.CAR_STATES.map((state, i) => ({ issue: i + 1, closed: trainCard.CLOSED_CAR_STATES.includes(state), state }))
    }));
    trainCard.CAR_STATES.forEach((state, i) => {
      const pill = html.match(new RegExp(`<span class="train-car ${state}" title="#${i + 1} ([a-z ]+)" aria-label="#${i + 1} ([a-z ]+)">`));
      assert.ok(pill, `${state} has a labelled pill`);
      assert.equal(pill[1], pill[2]);
      assert.match(html, new RegExp(`<td class="train-state">[^<]*${pill[1]}</td>`), `${state} is named in the table`);
      if (state !== 'open') assert.match(page, new RegExp(`\\.train-car\\.${state}\\{`), `${state} has a style`);
    });
  });

  it('requires a closed issue to be closed or dropped, and an open one to be anything else', () => {
    for (const state of ['open', 'in-progress', 'in-review', 'blocked']) {
      assert.match(render(train({ cars: [{ issue: 1, closed: false, state }] })), /class="train-card"/);
      refused(train({ cars: [{ issue: 1, closed: true, state }] }), /cars\[0\]\.state must agree with closed/);
    }
    for (const state of ['closed', 'dropped']) {
      assert.match(render(train({ cars: [{ issue: 1, closed: true, state }] })), /class="train-card"/);
      refused(train({ cars: [{ issue: 1, closed: false, state }] }), /cars\[0\]\.state must agree with closed/);
    }
    refused(train({ cars: [{ issue: 1, closed: false, state: 'done' }] }),
      /cars\[0\]\.state must be one of open, in-progress, blocked, closed, in-review, dropped\./);
  });

  it('counts a state-less closed car as closed, never as dropped', () => {
    const html = render(train({ cars: [{ issue: 6, closed: true }] }));
    assert.match(html, /train-car closed" title="#6 closed"/);
    assert.match(html, /\(1\/1\)/);
  });

  it('leaves a dropped car out of both figures of the count and reports it separately', () => {
    const html = render(train({
      cars: [
        { issue: 1, closed: true, state: 'closed' },
        { issue: 2, closed: true, state: 'dropped' },
        { issue: 3, closed: false, state: 'in-review' },
        { issue: 4, closed: false },
        { issue: 5, closed: true }
      ]
    }));
    assert.match(html, /<span class="train-count">\(2\/4\)<\/span>/);
    assert.match(html, /<strong>2 open \(1 in review\) · 2 closed · 1 dropped<\/strong>/);
  });

  it('lets a train finish when its only unfinished car was dropped', () => {
    const html = render(train({ cars: [{ issue: 1, closed: true }, { issue: 2, closed: true, state: 'dropped' }] }));
    assert.match(html, /<span class="train-count">\(1\/1\)<\/span>/);
    assert.match(html, /<strong>0 open · 1 closed · 1 dropped<\/strong>/);
  });

  it('reads 0/0 with the dropped count when every car was dropped', () => {
    const html = render(train({ cars: [{ issue: 1, closed: true, state: 'dropped' }, { issue: 2, closed: true, state: 'dropped' }] }));
    assert.match(html, /<span class="train-count">\(0\/0\)<\/span>/);
    assert.match(html, /<strong>0 open · 0 closed · 2 dropped<\/strong>/);
  });

  it('says nothing about dropped cars when there are none', () => {
    assert.doesNotMatch(render(train()), /dropped/);
  });

  it('shows the owning lane in words after the badges, escaped', () => {
    const html = render(train({ owner: 'TangleClaw-BuilderRule' }));
    assert.match(html, /<span class="train-badge">verified<\/span><span class="train-owner">lane: TangleClaw-BuilderRule<\/span><\/summary>/);
    const hostile = render(train({ owner: '<img src=x onerror=alert(1)>' }));
    assert.match(hostile, /<span class="train-owner">lane: &lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
    assert.doesNotMatch(hostile, /<img/);
  });

  it('draws no lane when there is no owner', () => {
    assert.doesNotMatch(render(train()), /train-owner|lane:/);
  });

  it('refuses an owner that is not a string, is blank, or is longer than the bound', () => {
    refused(train({ owner: 7 }), /owner must be a string/);
    refused(train({ owner: '   ' }), /owner must not be blank/);
    refused(train({ owner: '' }), /owner must not be blank/);
    refused(train({ owner: 'x'.repeat(trainCard.LIMITS.owner + 1) }), /owner is longer than 60 characters/);
    assert.match(render(train({ owner: 'x'.repeat(trainCard.LIMITS.owner) })), /class="train-owner"/);
  });
});

describe('release panels (#2165)', () => {
  /**
   * A valid release holding one train and one Topic Bucket, with overrides.
   * @param {object} [over] - Fields to replace.
   * @returns {object}
   */
  function release(over = {}) {
    return {
      version: '5.32.0',
      status: 'planned',
      trains: [
        train({ kind: 'train', train: 31 }),
        {
          kind: 'bucket',
          title: 'Install safety',
          cars: [
            { issue: 20, closed: true },
            { issue: 21, closed: false, state: 'in-review' },
            { issue: 22, closed: true, state: 'dropped' }
          ]
        }
      ],
      ...over
    };
  }

  /**
   * A release with one of its workstreams replaced.
   * @param {*} entry - The workstream to put first.
   * @returns {object}
   */
  const withEntry = (entry) => release({ trains: [entry] });

  /**
   * Render one `tc-release` block through the plan renderer.
   * @param {object|string} body - Release object, or raw block text.
   * @returns {string}
   */
  function renderRelease(body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    return planDocs.renderPlanBody(`\`\`\`tc-release\n${text}\n\`\`\``);
  }

  /**
   * Assert a release block is refused whole: no panel, no card, the code fallback and a reason matching `why`.
   * @param {object|string} body - Block.
   * @param {RegExp} why - Expected reason.
   * @returns {string} The HTML.
   */
  function refusedRelease(body, why) {
    const html = renderRelease(body);
    assert.doesNotMatch(html, /class="release-panel"|class="train-card"/);
    assert.match(html, /<p class="block-error">Release block not rendered: /);
    assert.match(html, /<pre><code class="language-tc-release">/);
    assert.match(html, why);
    return html;
  }

  describe('a valid block', () => {
    it('draws one panel with the version, the status badge and one card per workstream in order', () => {
      const html = renderRelease(release());
      assert.equal(html.match(/<section class="release-panel"/g).length, 1);
      assert.match(html, /<section class="release-panel" aria-label="Release 5\.32\.0"><div class="release-head"><span class="release-version">v5\.32\.0<\/span><span class="train-status status-planned">planned<\/span>/);
      assert.equal(html.match(/<details class="train-card">/g).length, 2);
      assert.ok(html.indexOf('Train 31: First Install, Completed') < html.indexOf('Topic Bucket: Install safety'));
      assert.match(html, /<\/details><\/section>$/);
    });

    it('draws each workstream exactly as a tc-train block draws it, issue table included', () => {
      const entry = train({ kind: 'train', train: 31 });
      assert.ok(renderRelease(withEntry(entry)).includes(render(entry)));
    });

    it('counts the header from the cars of every workstream, buckets included, and says workstreams', () => {
      // Train: one closed of two. Bucket: one closed, one in review, one dropped.
      assert.match(renderRelease(release()),
        /<span class="release-count" aria-label="2 of 4 cars done across 2 workstreams, 1 dropped">2\/4 cars · 2 workstreams · 1 dropped<\/span>/);
    });

    it('leaves dropped out of the header when no car is dropped, and writes one workstream in the singular', () => {
      assert.match(renderRelease(withEntry(train({ kind: 'train' }))),
        /<span class="release-count" aria-label="1 of 2 cars done across 1 workstream">1\/2 cars · 1 workstream<\/span>/);
    });

    it('reads 0/0 with the dropped count when every car is dropped', () => {
      const html = renderRelease(withEntry({
        kind: 'bucket', title: 'Abandoned', cars: [{ issue: 1, closed: true, state: 'dropped' }, { issue: 2, closed: true, state: 'dropped' }]
      }));
      assert.match(html, /aria-label="0 of 0 cars done across 1 workstream, 2 dropped">0\/0 cars · 1 workstream · 2 dropped</);
    });

    it('draws no status badge in the header when the release has no status', () => {
      const { status, ...rest } = release();
      assert.equal(status, 'planned');
      assert.match(renderRelease(rest), /<span class="release-version">v5\.32\.0<\/span><span class="release-count"/);
    });

    it('accepts a release at the workstream bound', () => {
      const trains = Array.from({ length: trainCard.LIMITS.releaseTrains }, (_, i) => train({ kind: 'train', train: i + 1, cars: [] }));
      assert.match(renderRelease(release({ trains })), /across 50 workstreams/);
    });

    it('keeps a number and a string ID apart, and a train apart from a bucket of the same title', () => {
      const html = renderRelease(release({
        trains: [
          train({ kind: 'train', train: 16 }),
          train({ kind: 'train', train: 'A16' }),
          { kind: 'bucket', title: 'First Install, Completed', cars: [] }
        ]
      }));
      assert.equal(html.match(/<details class="train-card">/g).length, 3);
    });

    it('styles the panel from the page stylesheet', () => {
      const page = planDocs.renderPlanPage({
        project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
      });
      assert.match(page, /section\.release-panel\{border:1px solid var\(--border\)/);
      assert.match(page, /\.release-head\{display:flex/);
    });
  });

  describe('the release schema is closed', () => {
    it('refuses a body that is not JSON, or not an object', () => {
      refusedRelease('{ not json', /block is not valid JSON/);
      refusedRelease('[]', /block must be a JSON object/);
    });

    it('refuses an unknown top-level key, so a total or a done figure cannot be supplied', () => {
      refusedRelease(release({ total: 99 }), /unknown key &quot;total&quot;/);
      refusedRelease(release({ done: 99 }), /unknown key &quot;done&quot;/);
      refusedRelease(release({ title: 'Recovery' }), /unknown key &quot;title&quot;/);
    });

    for (const bad of ['v5.32.0', '5.32', '05.32.0', '5.32.0-rc1', '5.32.0 ', '', '1'.repeat(20) + '.0.0', 5, undefined]) {
      it(`refuses the version ${JSON.stringify(bad)}`, () => {
        refusedRelease(release({ version: bad }), /version must be three numbers such as 5\.32\.0/);
      });
    }

    it('refuses a status outside the list', () => {
      refusedRelease(release({ status: 'done' }), /status must be one of planned, ready, in-progress, blocked, shipped, sunset/);
    });

    it('refuses trains that are missing, empty, not an array, or over the bound', () => {
      const { trains, ...rest } = release();
      assert.equal(trains.length, 2);
      refusedRelease(rest, /trains must be a non-empty array/);
      refusedRelease(release({ trains: [] }), /trains must be a non-empty array/);
      refusedRelease(release({ trains: { 0: train() } }), /trains must be a non-empty array/);
      const many = Array.from({ length: trainCard.LIMITS.releaseTrains + 1 }, (_, i) => train({ kind: 'train', train: i + 1, cars: [] }));
      refusedRelease(release({ trains: many }), /trains has more than 50 entries/);
    });

    it('refuses more cars in total than the bound, though each workstream is within its own', () => {
      const cars = Array.from({ length: 400 }, (_, i) => ({ issue: i + 1, closed: false }));
      const trains = [1, 2, 3].map((id) => train({ kind: 'train', train: id, cars }));
      refusedRelease(release({ trains }), /trains hold more than 1000 cars in total/);
    });

    it('refuses a body over the block bound before parsing it', () => {
      refusedRelease(JSON.stringify(release()) + ' '.repeat(trainCard.LIMITS.body), /block is larger than 200000 characters/);
    });
  });

  describe('a workstream is held to the train rules, at its own path', () => {
    it('refuses a workstream that is not an object', () => {
      refusedRelease(withEntry('Train 31'), /trains\[0\] must be an object/);
      refusedRelease(withEntry(null), /trains\[0\] must be an object/);
      refusedRelease(withEntry([]), /trains\[0\] must be an object/);
    });

    it('refuses an unknown key, a missing title and a malformed car, naming the workstream', () => {
      refusedRelease(release({ trains: [train({ kind: 'train' }), train({ kind: 'train', train: 2, colour: 'red' })] }),
        /trains\[1\] has unknown key &quot;colour&quot;/);
      refusedRelease(withEntry(train({ kind: 'train', title: undefined })), /trains\[0\]\.title must be a non-empty string/);
      refusedRelease(withEntry(train({ kind: 'train', cars: [{ issue: 1 }] })), /trains\[0\]\.cars\[0\]\.closed must be true or false/);
      refusedRelease(withEntry(train({ kind: 'train', cars: [{ issue: 1, closed: false, state: 'dropped' }] })),
        /trains\[0\]\.cars\[0\]\.state must agree with closed/);
      refusedRelease(withEntry(train({ kind: 'train', cars: 'none' })), /trains\[0\]\.cars must be an array/);
    });

    it('refuses a kind that is absent, a pilot or an unconfigured milestone', () => {
      refusedRelease(withEntry(train()), /trains\[0\]\.kind must be written out as one of train, bucket/);
      refusedRelease(withEntry(train({ kind: 'pilot', train: 'B2' })), /trains\[0\]\.kind must be written out as one of train, bucket/);
      refusedRelease(withEntry({ kind: 'unconfigured', title: 'Later', cars: [] }), /trains\[0\]\.kind must be written out as one of train, bucket/);
      refusedRelease(withEntry(train({ kind: 'release' })), /trains\[0\]\.kind must be one of train, bucket, pilot, unconfigured/);
    });

    it('refuses a version on a workstream, because the release states it', () => {
      refusedRelease(withEntry(train({ kind: 'train', version: '5.32.0' })), /trains\[0\]\.version must be absent inside a release/);
      refusedRelease(withEntry({ kind: 'bucket', title: 'B', version: 'v6', cars: [] }), /trains\[0\]\.version must be absent inside a release/);
    });

    it('refuses a train with no identity and a bucket with one', () => {
      refusedRelease(withEntry(train({ kind: 'train', train: undefined })), /trains\[0\]\.train must be an integer or a number/);
      refusedRelease(withEntry({ kind: 'bucket', train: 4, title: 'B', cars: [] }), /trains\[0\]\.train must be absent when kind is bucket/);
    });

    it('refuses a train identity used twice, however the number is written', () => {
      const entry = (id) => `{"kind":"train","train":${id},"title":"T","cars":[]}`;
      refusedRelease(`{"version":"5.32.0","trains":[${entry('16')},${entry('16.0')}]}`,
        /trains\[1\]\.train repeats another train in this release/);
      refusedRelease(release({ trains: [train({ kind: 'train', train: 'C-E' }), train({ kind: 'train', train: 'C-E' })] }),
        /trains\[1\]\.train repeats another train in this release/);
    });

    it('refuses two buckets whose titles differ only by case or surrounding spaces', () => {
      refusedRelease(release({
        trains: [{ kind: 'bucket', title: 'Install Safety', cars: [] }, { kind: 'bucket', title: '  install safety ', cars: [] }]
      }), /trains\[1\]\.title repeats another bucket in this release/);
    });

    for (const bad of [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://example.com/',
      '//evil.example/x', '/\\evil.example', 'https:\\\\evil.example', '/relative', 'relative.md',
      '\u0001javascript:alert(1)', 'https://exa mple.com', 'https:///x', ''
    ]) {
      it(`refuses the href ${JSON.stringify(bad)} on a workstream and on its car`, () => {
        refusedRelease(withEntry(train({ kind: 'train', href: bad })), /trains\[0\]\.href must be an absolute https URL/);
        refusedRelease(withEntry(train({ kind: 'train', cars: [{ issue: 1, closed: false, href: bad }] })),
          /trains\[0\]\.cars\[0\]\.href must be an absolute https URL/);
      });
    }
  });

  describe('escaping — nothing in a release becomes markup', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';

    it('escapes every string of a workstream and its cars', () => {
      const html = renderRelease(withEntry(train({
        kind: 'train', train: 'A-1', title: evil, thesis: evil, sequencing: evil, owner: evil.slice(0, 60),
        cars: [{ issue: 1, closed: false, type: evil.slice(0, 40), title: evil }]
      })));
      assert.match(html, /class="release-panel"/);
      assert.doesNotMatch(html, /<script|<img/);
      assert.match(html, /Train A-1: &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    it('refuses a string train ID carrying markup, and shows it only as escaped code', () => {
      const html = refusedRelease(withEntry(train({ kind: 'train', train: 'A<b>' })), /trains\[0\]\.train must be an integer or a number/);
      assert.doesNotMatch(html, /<b>/);
    });

    it('does not echo a refused value into the reason, and shows the source only as escaped code', () => {
      const html = refusedRelease(release({ version: '<img src=x onerror=alert(1)>' }), /version must be three numbers/);
      assert.doesNotMatch(html, /<img/);
      assert.doesNotMatch(html.split('</p>')[0], /onerror/);
      const key = refusedRelease(withEntry({ ...train({ kind: 'train' }), '<b>x</b>': 1 }), /trains\[0\] has unknown key &quot;&lt;b&gt;x&lt;\/b&gt;&quot;/);
      assert.doesNotMatch(key, /<b>/);
    });
  });

  describe('beside the other cards', () => {
    it('leaves a tc-train and a tc-queue block on the same page as they were', () => {
      const queue = { newDays: 14, issues: [{ issue: 9, createdAt: '2026-09-27T09:30:00Z' }] };
      const now = Date.parse('2026-09-28T00:00:00Z');
      const fence = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;
      const alone = [fence('tc-train', train()), fence('tc-queue', queue)].map((md) => planDocs.renderPlanBody(md, 0, { now }));
      const page = planDocs.renderPlanBody(
        [fence('tc-train', train()), fence('tc-release', release()), fence('tc-queue', queue)].join('\n\n'), 0, { now });
      assert.ok(page.includes(alone[0]));
      assert.ok(page.includes(alone[1]));
      assert.equal(page.match(/<section class="release-panel"/g).length, 1);
    });

    it('does not let a refused release stop the cards around it', () => {
      const fence = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;
      const page = planDocs.renderPlanBody([fence('tc-release', release({ version: 'v1' })), fence('tc-train', train())].join('\n\n'));
      assert.match(page, /Release block not rendered: /);
      assert.equal(page.match(/<details class="train-card">/g).length, 1);
    });

    it('exports the block name, the kinds and the bounds', () => {
      assert.equal(trainCard.RELEASE_BLOCK_INFO, 'tc-release');
      assert.deepEqual([...trainCard.RELEASE_KINDS], ['train', 'bucket']);
      assert.equal(trainCard.LIMITS.releaseTrains, 50);
      assert.equal(trainCard.LIMITS.releaseCars, 1000);
    });
  });
});
