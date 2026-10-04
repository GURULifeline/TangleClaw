'use strict';

/**
 * The helper's two secrets, kept only in the macOS Keychain (#2031, ADR 0023
 * Decision 11).
 *
 * A secret is read with `/usr/bin/security find-generic-password ... -w`,
 * whose standard output is the secret. It is stored by running `security -i`,
 * which reads its commands from standard input, and writing one
 * `add-generic-password -U ... -w <secret>` line to it. The secret is
 * therefore in no process's arguments (visible to `ps`), no environment
 * variable, no file and no log. Because that line is parsed as a command, a
 * value is limited to the characters both tokens use, so it cannot close a
 * quote or start a second command. A failure of either call is mapped to a
 * closed code and not passed on: `security`'s own output is not ours to vouch
 * for.
 *
 * @module lib/bridge-helper/secrets
 */

const { execFile, spawn } = require('node:child_process');

/** The two secrets, by the name the CLI uses. */
const SECRETS = Object.freeze({
  bot: Object.freeze({ service: 'tangleclaw-bridge-helper', account: 'discord-bot-token', shape: /^[A-Za-z0-9._-]{20,512}$/ }),
  helper: Object.freeze({ service: 'tangleclaw-bridge-helper', account: 'bridge-helper-token', shape: /^bht_[A-Za-z0-9_-]{43}$/ })
});

const SECURITY = '/usr/bin/security';

/** How long a Keychain call may take before it is abandoned. */
const TIMEOUT_MS = 10000;

/** A refusal whose message names a code and a secret's name, never its value or `security`'s output. */
class SecretError extends Error {
  /**
   * @param {('secret-missing'|'secret-read-failed'|'secret-store-failed'|'secret-malformed')} code - Why.
   * @param {string} name - Which secret.
   */
  constructor(code, name) {
    super(`${code}: ${name}`);
    this.code = code;
    this.secretName = name;
  }
}

/**
 * Process seams, so a test can prove what reaches argv and stdin.
 * @type {{execFile: Function, spawn: Function}}
 */
const _internal = { execFile, spawn };

/**
 * Read one secret from the Keychain.
 * @param {('bot'|'helper')} name - Which secret.
 * @returns {Promise<string>}
 */
function readSecret(name) {
  const item = SECRETS[name];
  if (!item) return Promise.reject(new SecretError('secret-read-failed', String(name)));
  return new Promise((resolve, reject) => {
    _internal.execFile(SECURITY, ['find-generic-password', '-s', item.service, '-a', item.account, '-w'],
      { timeout: TIMEOUT_MS }, (err, stdout) => {
        // 44 is `security`'s "item not found".
        if (err) return reject(new SecretError(err.code === 44 ? 'secret-missing' : 'secret-read-failed', name));
        const value = String(stdout || '').replace(/\n$/, '');
        if (!value) return reject(new SecretError('secret-missing', name));
        if (!item.shape.test(value)) return reject(new SecretError('secret-malformed', name));
        resolve(value);
      });
  });
}

/**
 * Store one secret in the Keychain, replacing any earlier value.
 * @param {('bot'|'helper')} name - Which secret.
 * @param {string} value - The secret; it travels on stdin only.
 * @returns {Promise<void>}
 */
function storeSecret(name, value) {
  const item = SECRETS[name];
  if (!item) return Promise.reject(new SecretError('secret-store-failed', String(name)));
  if (typeof value !== 'string' || !item.shape.test(value)) return Promise.reject(new SecretError('secret-malformed', name));
  return new Promise((resolve, reject) => {
    const child = _internal.spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(); else reject(new SecretError('secret-store-failed', name));
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, TIMEOUT_MS);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    child.stdin.end(`add-generic-password -U -s ${item.service} -a ${item.account} -w ${value}\n`);
  });
}

module.exports = { SECRETS, SecretError, readSecret, storeSecret, _internal };
