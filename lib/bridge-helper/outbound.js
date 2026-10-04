'use strict';

/**
 * TangleClaw to Discord (#2031, ADR 0023 Decision 11).
 *
 * Each pass claims what waits at the bridge, posts each item to the one
 * allowlisted channel, and acknowledges it under its lease only once Discord
 * has returned the posted message's id. Nothing is acknowledged on hope.
 *
 * A lease gives the helper two minutes; it does not make a post safe to
 * repeat. What does is the local record (`state.js`) and Discord's nonce:
 *
 * - Before a part goes out, the item's entry records that an attempt whose
 *   outcome is not yet known began (`since`).
 * - A failure Discord definitely did not act on clears `since`, but only when
 *   that same attempt set it. An earlier attempt that may have landed stays in
 *   doubt whatever a later one says.
 * - A failure that may have posted keeps `since`. The retry reuses the same
 *   nonce, so inside Discord's de-duplication window it returns the message
 *   already made instead of making another.
 * - Past that window a retry could duplicate, so the item becomes
 *   `uncertain`: never reposted by itself, and shown by `status` until the
 *   operator settles it.
 * - A 400 rejects the item's own content and would again, so that item is
 *   held as `rejected` and the rest keep moving. Any other refusal concerns
 *   the whole channel, so the pass stops and the helper backs off.
 *
 * The nonce of a claim is recorded before the claim is made, and cleared only
 * when everything it handed over has been dealt with. Until then each pass
 * asks the same claim again first, and the bridge returns the same leases. So
 * a lost answer, a pass that stopped part-way and a restart all carry on with
 * what was already handed over, inside the nonce's window, without waiting
 * for a lease to lapse.
 *
 * An item that posted but could not be acknowledged keeps its entry. It is
 * acknowledged again on a later pass: under the lease it still holds if that
 * is live, or under the new one when the bridge hands it over again. It is
 * never posted a second time.
 *
 * An item is checked before it is posted: its text against the digest it was
 * handed over with, and the channel it names against the allowlisted one. The
 * helper posts to that one channel and no other, whatever an item says.
 *
 * @module lib/bridge-helper/outbound
 */

const crypto = require('node:crypto');
const { nonceFor } = require('./state');
const { newNonce } = require('./bridge-client');

/** The most characters posted as one Discord message; Discord allows 2000. */
const PART_MAX = 1900;

/** How long a nonce is trusted to de-duplicate a retry. Discord promises "the past few minutes"; this stays inside that. */
const NONCE_WINDOW_MS = 2 * 60 * 1000;

/** The least time a lease must have left for a part to be posted under it. */
const LEASE_MARGIN_MS = 20 * 1000;

/** States the operator settles by hand; a pass never retries them. */
const HELD = new Set(['uncertain', 'rejected']);

/** A failure that was logged where it happened. It ends the pass, and the pass has nothing to add. */
class Reported extends Error {
  constructor() {
    super('reported');
  }
}

/**
 * A settlement the operator asked for that cannot be applied. `code` says
 * why: `not-held`, `wrong-state`, `duplicate-part`, `bad-id` or
 * `bad-settlement`.
 */
class SettleError extends Error {
  /**
   * @param {string} code - The closed reason.
   */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * The text to post for one item: who it is from, then what was said. The
 * label is the bridge's; anything in it that Discord would read as formatting
 * is escaped, so a project's name cannot restyle the line.
 * @param {{sourceLabel: string, text: string}} item - A claimed item.
 * @returns {string}
 */
function render(item) {
  const label = String(item.sourceLabel || 'TangleClaw').replace(/([\\*_~`|>#[\]()@:])/g, '\\$1');
  return `**${label}**\n${item.text}`;
}

/**
 * Split text into Discord-sized parts, preferring a line break in the second
 * half of a part, and never splitting a character in two.
 * @param {string} text - Rendered text.
 * @returns {string[]}
 */
function split(text) {
  const chars = Array.from(text);
  const parts = [];
  let at = 0;
  while (chars.length - at > PART_MAX) {
    let cut = at + PART_MAX;
    for (let i = cut; i > at + PART_MAX / 2; i--) {
      if (chars[i - 1] === '\n') { cut = i; break; }
    }
    parts.push(chars.slice(at, cut).join(''));
    at = cut;
  }
  parts.push(chars.slice(at).join(''));
  return parts.filter((part) => part.trim().length > 0);
}

/**
 * Make the outbound relay.
 * @param {object} opts
 * @param {string} opts.channelId - The one allowlisted channel.
 * @param {{claim: Function, ack: Function}} opts.bridge - Bridge client.
 * @param {{createMessage: Function}} opts.rest - Discord REST client.
 * @param {object} opts.state - Open state record (`state.js#openState`).
 * @param {function(string, object=): void} opts.log - Closed-code log.
 * @param {function(): number} [opts.now] - Clock, epoch ms.
 * @returns {{pass: function(): Promise<{ok: boolean, posted: number, acked: number, held: number}>}}
 */
function createOutbound({ channelId, bridge, rest, state, log, now = Date.now }) {
  /** Entries this process could not write back, so a posted part is never forgotten while it runs. */
  const unsaved = new Map();
  /**
   * An item's entry: this process's own when a write failed, else the record's.
   * @param {number} id - Outbound id.
   * @returns {object|undefined}
   */
  const entryOf = (id) => unsaved.get(id) || state.get(id);

  /**
   * Record an item's entry. A write that fails is reported and ends the pass.
   *
   * What this process then remembers depends on what the write was for. A
   * write made after Discord answered records something that has happened, so
   * the entry is kept here and the part is not posted again while the helper
   * runs. A write made before a post records an intention; if it fails the
   * intention is dropped, not remembered, so the next pass must write it
   * again before it may post.
   * @param {number} id - Outbound id.
   * @param {object} entry - What to hold.
   * @param {object} [options]
   * @param {boolean} [options.happened=true] - False for the write made before a post.
   * @returns {void}
   * @throws {Reported} When the record could not be written.
   */
  function save(id, entry, options = {}) {
    // A copy: the caller goes on changing its own entry, and the record must
    // hold what was written, not what happened afterwards.
    const held = { ...entry, parts: [...entry.parts] };
    try {
      state.set(id, held);
      unsaved.delete(id);
    } catch { // prawduct:allow prawduct/broad-except -- the state module answers every failed write with one closed code
      if (options.happened !== false) unsaved.set(id, held);
      log('state-write-failed', { outboundId: id });
      throw new Reported();
    }
  }

  /**
   * Forget an item: it is settled at the bridge.
   * @param {number} id - Outbound id.
   * @returns {void}
   * @throws {Reported} When the record could not be written.
   */
  function forget(id) {
    try {
      state.remove(id);
      unsaved.delete(id);
    } catch { // prawduct:allow prawduct/broad-except -- the state module answers every failed write with one closed code
      log('state-write-failed', { outboundId: id });
      throw new Reported();
    }
  }

  /**
   * Acknowledge a fully posted item under a lease.
   * @param {number} id - Outbound id.
   * @param {object} entry - Its entry, with every part posted.
   * @param {string} leaseId - The lease to acknowledge under.
   * @returns {Promise<boolean>} True when the bridge has it as delivered.
   * @throws {Reported} When the bridge could not be reached.
   */
  async function acknowledge(id, entry, leaseId) {
    try {
      await bridge.ack(id, leaseId, entry.parts[0]);
      forget(id);
      log('outbound-acked', { outboundId: id });
      return true;
    } catch (err) { // prawduct:allow prawduct/broad-except -- a Reported passes through; every other failure is the client's typed BridgeError, answered below
      if (err instanceof Reported) throw err;
      const status = Number(err && err.status) || 0;
      const code = err && err.refusalCode;
      if (code === 'OUTBOUND_EXPIRED' || code === 'OUTBOUND_NOT_FOUND' || code === 'ACK_MISMATCH') {
        // The bridge will never take this acknowledgement: the item was let
        // go, is gone, or is already delivered under another message id.
        forget(id);
        log(code === 'OUTBOUND_EXPIRED' ? 'outbound-ack-expired' : 'outbound-ack-refused', { outboundId: id, status });
        return false;
      }
      if (code === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('outbound-ack-failed', { outboundId: id, status });
      // A lapsed or foreign lease is this item's alone, and the item is still
      // waiting: the bridge answers for a delivered or dropped item before it
      // looks at the lease. So it is handed over again and acknowledged then.
      // Anything else is the bridge itself not answering, so the pass stops.
      if (code === 'LEASE_LAPSED' || code === 'LEASE_NOT_FOUND' || code === 'LEASE_NOT_YOURS') return false;
      throw new Reported();
    }
  }

  /**
   * Post what is left of one claimed item, then acknowledge it.
   * @param {object} item - A claimed item with a live lease.
   * @returns {Promise<{outcome: ('acked'|'unacked'|'held'|'skipped'), posted: boolean}>} `posted` says whether any part was sent on this call.
   * @throws {Reported} When the pass should stop.
   */
  async function relay(item) {
    const id = item.outboundId;
    let entry = entryOf(id);
    if (entry && HELD.has(entry.status)) return { outcome: 'held', posted: false };
    if (item.inReplyTo && item.inReplyTo.channelId !== channelId) {
      log('outbound-foreign-channel', { outboundId: id });
      return { outcome: 'skipped', posted: false };
    }
    if (typeof item.text !== 'string' || crypto.createHash('sha256').update(item.text, 'utf8').digest('hex') !== item.digest) {
      log('outbound-digest-mismatch', { outboundId: id });
      return { outcome: 'skipped', posted: false };
    }
    const parts = split(render(item));
    entry = entry ? { ...entry, parts: [...entry.parts], leaseId: item.leaseId } : { status: 'posting', parts: [], round: 0, leaseId: item.leaseId };

    let posted = false;
    while (entry.parts.length < parts.length) {
      const part = entry.parts.length;
      if (entry.since && now() - entry.since > NONCE_WINDOW_MS) {
        save(id, { ...entry, status: 'uncertain' });
        log('outbound-uncertain', { outboundId: id, part });
        return { outcome: 'held', posted };
      }
      if (Date.parse(item.expiresAt) - now() < LEASE_MARGIN_MS) {
        log('outbound-lease-short', { outboundId: id });
        return { outcome: 'skipped', posted };
      }
      const opened = !entry.since;
      if (opened) {
        // On disk before anything is sent, or nothing is sent.
        const since = now();
        save(id, { ...entry, since }, { happened: false });
        entry.since = since;
      }
      let made;
      try {
        made = await rest.createMessage(channelId, {
          content: parts[part], nonce: nonceFor(state.salt, id, part, entry.round),
          replyTo: part === 0 && item.inReplyTo ? item.inReplyTo.externalId : null
        });
      } catch (err) { // prawduct:allow prawduct/broad-except -- every post failure is the client's typed DiscordError, answered below
        const status = Number(err && err.status) || 0;
        const notSent = err && err.sent === 'no';
        if (notSent && opened) {
          delete entry.since;
          save(id, entry);
        }
        if (notSent && status === 400) {
          const held = opened ? 'rejected' : 'uncertain';
          save(id, { ...entry, status: held });
          log(`outbound-${held}`, { outboundId: id, part });
          return { outcome: 'held', posted };
        }
        log('outbound-post-failed', { outboundId: id, status });
        throw new Reported();
      }
      posted = true;
      entry.parts.push(made.id);
      delete entry.since;
      if (entry.parts.length === parts.length) entry.status = 'posted';
      // If this write fails the part stays on the entry this process holds,
      // so it is not posted again while the helper runs.
      save(id, entry);
      log('outbound-posted', { outboundId: id, part });
    }
    return { outcome: (await acknowledge(id, entry, item.leaseId)) ? 'acked' : 'unacked', posted };
  }

  /**
   * Ask the bridge for a claim's items, by its nonce.
   * @param {string} nonce - The claim's nonce.
   * @returns {Promise<object[]|null>} The items whose lease is live; null when the bridge refused the claim itself.
   * @throws {Reported} When the bridge could not be asked.
   */
  async function ask(nonce) {
    try {
      const { items } = await bridge.claim(nonce);
      return items.filter((item) => item.leaseState === 'live');
    } catch (err) { // prawduct:allow prawduct/broad-except -- every claim failure is the client's typed BridgeError, answered below
      const status = Number(err && err.status) || 0;
      // The nonce is another request's now: the helper token was replaced
      // since the claim was made. There is nothing of it left to carry on with.
      if (err && err.refusalCode === 'NONCE_REUSED') return null;
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('claim-failed', { status });
      throw new Reported();
    }
  }

  /**
   * Record the nonce of the claim in progress, or that there is none.
   * @param {string|null} nonce - The nonce.
   * @returns {void}
   * @throws {Reported} When the record could not be written.
   */
  function noteClaim(nonce) {
    try {
      state.setClaim(nonce);
    } catch { // prawduct:allow prawduct/broad-except -- the state module answers every failed write with one closed code
      log('state-write-failed');
      throw new Reported();
    }
  }

  return {
    /**
     * One pass: acknowledge what was posted and not yet taken, carry on with
     * the claim in progress if there is one, then make a new claim and relay
     * what it hands over.
     * @returns {Promise<{ok: boolean, posted: number, acked: number, held: number}>} `posted` counts the items a part was sent for; `ok` is false when the pass stopped early and the helper should back off.
     */
    async pass() {
      const out = { ok: true, posted: 0, acked: 0, held: 0 };
      /**
       * Relay every item of one claim.
       * @param {object[]|null} items - The claim's live items.
       * @returns {Promise<void>}
       */
      const relayAll = async (items) => {
        for (const item of items || []) {
          const done = await relay(item);
          if (done.posted) out.posted += 1;
          if (done.outcome === 'acked') out.acked += 1;
        }
      };
      try {
        for (const [id, entry] of state.entries()) {
          if (entry.status === 'posted' && entry.leaseId && await acknowledge(id, entry, entry.leaseId)) out.acked += 1;
        }
        const inProgress = state.claim();
        if (inProgress) await relayAll(await ask(inProgress));
        // Recorded before it is asked, so a claim the bridge acted on is
        // never one the helper has forgotten.
        const nonce = newNonce();
        noteClaim(nonce);
        await relayAll(await ask(nonce));
        noteClaim(null);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a pass never throws: a Reported was logged where it happened, anything else is logged here by its type alone
        if (!(err instanceof Reported)) log('outbound-pass-failed', { error: err && err.name ? String(err.name) : 'Error' });
        out.ok = false;
      }
      out.held = state.entries().filter(([, entry]) => HELD.has(entry.status)).length;
      return out;
    }
  };
}

/**
 * Settle a held item with what the operator saw in the channel. Run with the
 * helper stopped.
 *
 * An `uncertain` part either posted (`posted`: its Discord id is recorded and
 * the relay goes on from the next part) or did not (`repost`: it is posted
 * again, under a new nonce). A `rejected` item did not post, so it takes
 * `repost` alone, once whatever Discord refused is put right.
 * @param {object} state - Open state record (`state.js#openState`).
 * @param {number} id - Outbound id.
 * @param {{posted?: string, repost?: boolean}} finding - Exactly one.
 * @returns {{part: number}} The part the relay carries on from.
 * @throws {SettleError}
 */
function settleHeld(state, id, finding) {
  const entry = state.get(id);
  if (!entry || !HELD.has(entry.status)) throw new SettleError('not-held');
  const posted = Boolean(finding) && finding.posted !== undefined;
  if (posted === Boolean(finding && finding.repost)) throw new SettleError('bad-settlement');
  const next = { ...entry, parts: [...entry.parts], status: 'posting' };
  delete next.since;
  if (posted) {
    if (entry.status !== 'uncertain') throw new SettleError('wrong-state');
    if (typeof finding.posted !== 'string' || !/^\d{15,20}$/.test(finding.posted)) throw new SettleError('bad-id');
    if (entry.parts.includes(finding.posted)) throw new SettleError('duplicate-part');
    next.parts.push(finding.posted);
  } else {
    next.round = (entry.round || 0) + 1;
  }
  state.set(id, next);
  return { part: next.parts.length + 1 };
}

module.exports = { createOutbound, settleHeld, render, split, Reported, SettleError, HELD, PART_MAX, NONCE_WINDOW_MS, LEASE_MARGIN_MS };
