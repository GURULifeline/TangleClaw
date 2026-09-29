'use strict';

/*
 * #2032: the coordinator rotation routes are bound to the caller's own
 * verified launch (abandon to the operator), so no other pane, peer or
 * unbound caller can prepare, read, advance or resume a coordinator's
 * rotation. The transition rules themselves are pinned in
 * test/coordinator-rotation.test.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

describe('API — coordinator rotation routes (#2032)', () => {
  let tempDir;
  let server;
  let port;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-api-'));
    store._setBasePath(tempDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path.
   * @param {string} method - Method.
   * @param {object} [body] - JSON body.
   * @param {object} [headers] - Extra headers.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  const LAUNCH_BOUND = [
    ['POST', '/api/tc/rotation/prepare', { attemptKey: 'attempt-0001', checkpoint: {} }],
    ['GET', '/api/tc/rotation', null],
    ['POST', '/api/tc/rotation/advance', {}],
    ['POST', '/api/tc/rotation/resume', { rotationId: 'rot_x' }]
  ];

  for (const [method, url, body] of LAUNCH_BOUND) {
    it(`${method} ${url} refuses a caller with no verified launch`, async () => {
      const { status, data } = await req(url, method, body);
      assert.equal(status, 403);
      assert.equal(data.code, 'ROTATION_BINDING_REQUIRED');
    });

    it(`${method} ${url} refuses a launch id nobody holds`, async () => {
      const { status, data } = await req(url, method, body, { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' });
      assert.equal(status, 403);
      assert.equal(data.code, 'ROTATION_BINDING_REQUIRED');
    });
  }

  for (const [method, url, body] of [
    ['GET', '/api/coordinator-roles', null],
    ['POST', '/api/coordinator-roles', { projectId: 1, role: 'architect' }],
    ['POST', '/api/coordinator-roles/revoke', { projectId: 1 }]
  ]) {
    it(`${method} ${url} is the operator's alone (A6a)`, async () => {
      const { status, data } = await req(url, method, body, { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' });
      assert.equal(status, 403);
      assert.equal(data.code, 'OPERATOR_ONLY');
    });
  }

  for (const [method, url, body] of [
    ['POST', '/api/tc/rotation/relaunch', { rotationId: 'rot_x' }],
    ['GET', '/api/rotations', null]
  ]) {
    it(`${method} ${url} is the operator's alone (A13)`, async () => {
      const { status, data } = await req(url, method, body, { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' });
      assert.equal(status, 403);
      assert.equal(data.code, 'OPERATOR_ONLY');
    });
  }

  it('abandon refuses a project caller: it is the operator\'s exit', async () => {
    const { status, data } = await req('/api/tc/rotation/abandon', 'POST', { rotationId: 'rot_x', reason: 'x' },
      { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' });
    assert.equal(status, 403);
    assert.equal(data.code, 'OPERATOR_ONLY');
  });
});

describe('API — every gated route answers the epoch gate (#2032)', () => {
  let tempDir;
  let server;
  let port;
  let project;
  let other;
  const LAUNCH = 'launch-gate-routes-1';
  const OTHER_LAUNCH = 'launch-gate-routes-2';

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-gate-api-'));
    store._setBasePath(tempDir);
    store.init();
    const mk = (name, launchId) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-gate-${name}-`));
      const p = store.projects.create({ name, path: dir, engine: 'codex' });
      const sess = store.sessions.start({
        projectId: p.id, engineId: 'codex', tmuxSession: `tc-gate-${name}`, primePrompt: '',
        launchSequence: { launchId, pageBudget: 10000, applicability: 'not-applicable', notApplicableReason: 'test',
          preflight: {}, sourceManifest: {}, steps: [] }
      });
      return { ...p, sessionId: sess.id };
    };
    project = mk('gate-coordinator', LAUNCH);
    other = mk('gate-other', OTHER_LAUNCH);
    const now = new Date().toISOString();
    store.coordinatorRotations.insert({
      rotationId: 'rot_gate_routes', attemptKey: 'gate-routes-0001', projectId: project.id, sessionId: project.sessionId,
      launchId: LAUNCH, engineId: 'codex', channelId: 1, sequenceId: 1, generation: 1, priorThreadId: 'old-thread',
      checkpointSchema: 1, checkpointDigest: 'd'.repeat(64), checkpoint: { exchanges: [] }, inboxIds: [],
      roleId: 'role_x', authorityVersion: 1, checkout: {}, github: [], now
    });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path.
   * @param {string} method - Method.
   * @param {object|null} body - JSON body.
   * @param {object} headers - Headers.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body, headers) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  // The routes the gate is wired into, and which project each one judges:
  // the URL's project for the Medusa and wrap routes, the caller's for the rest.
  const ROUTES = [
    ['POST', '/api/sessions/gate-coordinator/medusa/send', { to: 'x', message: 'go' }],
    ['POST', '/api/sessions/gate-coordinator/medusa/read', { ids: ['m-1'] }],
    ['POST', '/api/sessions/gate-coordinator/medusa/exchanges/mx_1/close', {}],
    ['POST', '/api/tc/workload', { schema: 'tc.workload/1', state: 'working', clearance: 'do-not-clear', summary: 'x' }],
    ['POST', '/api/session-rules', { projectId: 1, content: 'x' }],
    ['PUT', '/api/session-rules/1', { content: 'x' }],
    ['DELETE', '/api/session-rules/1', null],
    ['POST', '/api/session-rules/promote', { id: 1 }],
    ['PUT', '/api/session-rules/1/status', { status: 'retired' }],
    ['POST', '/api/session-rules/1/restore', {}],
    ['POST', '/api/control/assignments', { projectId: 2 }],
    ['POST', '/api/control/assignments/a1/hold', {}],
    ['POST', '/api/control/assignments/a1/release', {}],
    ['POST', '/api/control/assignments/a1/stop', {}],
    ['POST', '/api/control/assignments/a1/close', {}],
    ['POST', '/api/control/assignments/a1/ack', {}],
    ['POST', '/api/control/assignments/a1/exchange-closed', {}],
    ['POST', '/api/sessions/gate-coordinator/wrap', {}],
    ['POST', '/api/sessions/gate-coordinator/wrap/complete', {}],
    ['POST', '/api/sessions/gate-coordinator/wrap/handback', {}]
  ];

  const coordinatorHeaders = () => ({
    'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'test',
    'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': LAUNCH, 'x-tangleclaw-engine-thread': 'old-thread'
  });

  for (const [method, url, body] of ROUTES) {
    it(`${method} ${url} is fenced for the rotating coordinator's own launch`, async () => {
      const { status, data } = await req(url, method, body, coordinatorHeaders());
      assert.equal(status, 409, JSON.stringify(data));
      assert.equal(data.code, 'COORDINATOR_FENCED');
    });
  }

  it('the caller-keyed routes judge the caller: another project\'s launch is not fenced by this rotation', async () => {
    const headers = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'test',
      'x-tangleclaw-project-id': String(other.id), 'x-tangleclaw-launch-id': OTHER_LAUNCH };
    for (const [method, url, body] of ROUTES.filter(([, u]) => !u.includes('gate-coordinator'))) {
      const { data } = await req(url, method, body, headers);
      assert.notEqual(data && data.code, 'COORDINATOR_FENCED', `${method} ${url}`);
    }
  });
});
