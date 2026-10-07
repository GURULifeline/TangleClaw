'use strict';

/*
 * #880 changed the shipped projects directory. An install that already exists
 * must stay on the directory it has been using, including one whose config
 * file predates the `projectsDir` key and so never wrote it down.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('projectsDir across the #880 default change', () => {
  let tmpDir;
  let store;
  let configFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-dir-'));
    store = require('../lib/store');
    store._setBasePath(tmpDir);
    configFile = store.config.file();
  });

  beforeEach(() => {
    fs.rmSync(configFile, { force: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ships a new default that differs from the one before #880', () => {
    assert.equal(store.DEFAULT_CONFIG.projectsDir, '~/Projects');
    assert.equal(store.LEGACY_PROJECTS_DIR, '~/Documents/Projects');
  });

  it('keeps an existing install with no projectsDir key on the old directory', () => {
    fs.writeFileSync(configFile, JSON.stringify({ serverPort: 3101, setupComplete: true }));
    assert.equal(store.config.isKeyPersisted('projectsDir'), false, 'the fixture really lacks the key');
    assert.equal(store.config.load().projectsDir, store.LEGACY_PROJECTS_DIR);
  });

  it('writes the old directory out on the next save, so it no longer depends on any default', () => {
    fs.writeFileSync(configFile, JSON.stringify({ serverPort: 3101, setupComplete: true }));
    store.config.save(store.config.load());
    assert.equal(store.config.isKeyPersisted('projectsDir'), true);
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).projectsDir, store.LEGACY_PROJECTS_DIR);
    assert.equal(store.config.load().projectsDir, store.LEGACY_PROJECTS_DIR);
  });

  it('keeps whatever directory an existing install wrote down', () => {
    for (const chosen of ['~/Documents/Projects', '~/code', '/srv/projects', store.DEFAULT_CONFIG.projectsDir]) {
      fs.writeFileSync(configFile, JSON.stringify({ projectsDir: chosen }));
      assert.equal(store.config.load().projectsDir, chosen);
    }
  });

  it('gives a new install, which has no config file, the new default', () => {
    assert.equal(fs.existsSync(configFile), false);
    assert.equal(store.config.load().projectsDir, store.DEFAULT_CONFIG.projectsDir);
  });

  it('never changes the default object while answering for an old install', () => {
    fs.writeFileSync(configFile, JSON.stringify({ serverPort: 3101 }));
    store.config.load();
    assert.equal(store.DEFAULT_CONFIG.projectsDir, '~/Projects');
  });
});
