'use strict';

/**
 * The helper's durable record of what it is posting (#2031).
 *
 * One entry per TangleClaw outbound item. Before a part is sent the entry
 * says so, with the time; the moment Discord answers, the entry holds the
 * posted message's id. A restart therefore finds either an item it knows it
 * posted, which it only acknowledges again, or one whose post may or may not
 * have landed. An item is acknowledged to TangleClaw under whatever lease it
 * currently holds, so this record, not the lease, is what stops a second post
 * when a lease lapses between the post and the acknowledgement.
 *
 * The file is owner-only and written atomically: a temporary file, then a
 * rename. A write that fails changes nothing, on disk or in this process, so
 * a caller that could not record an attempt has not made one.
 *
 * It holds the nonce of the claim in progress too. The bridge returns the
 * same leases to a claim repeated under its nonce, so a helper that lost the
 * answer, stopped part-way through, or restarted asks again with this nonce
 * and carries on with what it was handed, instead of waiting for those leases
 * to lapse.
 *
 * It also holds a salt for Discord nonces. A nonce is derived from the
 * outbound id, and ids start again from 1 if TangleClaw's database is
 * replaced; the salt keeps a new install's item 1 from matching an old one
 * inside Discord's de-duplication window.
 *
 * @module lib/bridge-helper/state
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * The state file exists but cannot be read. It is never replaced by an empty
 * record: forgetting a post in flight could make it twice.
 */
class StateError extends Error {
  constructor() {
    super('state-unreadable');
    this.code = 'state-unreadable';
  }
}

/** The state file could not be written. The record on disk is what it was. */
class StateWriteError extends Error {
  constructor() {
    super('state-write-failed');
    this.code = 'state-write-failed';
  }
}

/**
 * Read the state file.
 * @param {string} file - Its path.
 * @returns {{salt: string, items: object}|null} Null when there is no file yet.
 * @throws {StateError} When the file exists and is not a state record.
 */
function readData(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new StateError();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateError();
  }
  if (!parsed || typeof parsed.salt !== 'string' || !parsed.items || typeof parsed.items !== 'object') throw new StateError();
  return parsed;
}

/**
 * The entries, read without writing: for `status`, which runs beside a live
 * helper and must never write back a copy older than the helper's.
 * @param {string} file - Its path.
 * @returns {Array<[number, object]>}
 * @throws {StateError} When the file exists and is not a state record.
 */
function peekState(file) {
  const data = readData(file);
  return data ? Object.entries(data.items).map(([id, entry]) => [Number(id), entry]) : [];
}

/**
 * Open the state file, creating it if there is none. One process holds it at
 * a time: the running helper, or `settle` while the helper is stopped.
 * @param {string} file - Its path.
 * @returns {{salt: string, get: function(number): (object|undefined), set: function(number, object): void, remove: function(number): void, entries: function(): Array<[number, object]>, claim: function(): (string|null), setClaim: function((string|null)): void}}
 * @throws {StateError} When the file exists and is not a state record.
 * @throws {StateWriteError} When it cannot be written; `set` and `remove` throw it too.
 */
function openState(file) {
  const data = readData(file) || { salt: crypto.randomBytes(3).toString('hex'), items: {} };
  /**
   * Write the record with `items` and `claim` in it, and only then make them
   * this process's own.
   * @param {object} items - The entries to hold from now on.
   * @param {string|null} [claim] - The nonce of the claim in progress; unchanged by default.
   * @returns {void}
   * @throws {StateWriteError} When the write failed; nothing changed.
   */
  const save = (items, claim = data.claim || null) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ salt: data.salt, claim, items }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { // prawduct:allow prawduct/broad-except -- any failed write is one answer, a closed code; fs's own message names paths
      try { fs.rmSync(tmp, { force: true }); } catch { /* the next write replaces it */ }
      throw new StateWriteError();
    }
    data.items = items;
    data.claim = claim;
  };
  save(data.items);
  return {
    salt: data.salt,
    get: (id) => data.items[String(id)],
    set: (id, entry) => save({ ...data.items, [String(id)]: entry }),
    remove: (id) => {
      const rest = { ...data.items };
      delete rest[String(id)];
      save(rest);
    },
    entries: () => Object.entries(data.items).map(([id, entry]) => [Number(id), entry]),
    claim: () => data.claim || null,
    setClaim: (nonce) => save(data.items, nonce)
  };
}

/**
 * The Discord nonce for one part of one item: at most 25 characters, as
 * Discord requires. The same part of the same item always has the same nonce,
 * which is what lets a retry be recognised as a repeat.
 * @param {string} salt - The state file's salt.
 * @param {number} outboundId - TangleClaw's outbound id.
 * @param {number} part - Which part, from 0.
 * @param {number} [round=0] - How many times the operator has asked for this part to be posted again.
 * @returns {string}
 */
function nonceFor(salt, outboundId, part, round = 0) {
  return `tc${salt}-${outboundId}-${part}${round ? `-${round}` : ''}`.slice(0, 25);
}

module.exports = { StateError, StateWriteError, openState, peekState, nonceFor };
