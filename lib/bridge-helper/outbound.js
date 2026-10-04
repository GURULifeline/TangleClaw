'use strict';

/**
 * TangleClaw to Discord (#2031, ADR 0023 Decision 11).
 *
 * Each pass claims what waits at the bridge, posts each item to the one
 * allowlisted channel, and acknowledges it under its lease only once Discord
 * has returned the posted message's id. Nothing is acknowledged on hope.
 *
 * A lease gives the helper two minutes; it does not make a post safe to
 * repeat. Three things do, together:
 *
 * - **The bridge's record of parts.** Each message Discord makes is reported
 *   at once. A later claim of the same item says which parts are already
 *   posted, so whoever picks the item up carries on after them. A reply to a
 *   posted part is known for what it answers from that moment.
 * - **The helper's own record** (`state.js`), for the one thing the bridge
 *   cannot know: an attempt whose outcome is in doubt. Before a part goes out
 *   the entry records that an attempt began (`since`). A failure Discord
 *   definitely did not act on clears it, but only when that same attempt set
 *   it. A failure that may have posted keeps it.
 * - **Discord's nonce.** A retry of an attempt in doubt reuses its nonce, so
 *   inside Discord's de-duplication window it returns the message already
 *   made. Past that window a retry could duplicate, so the item is held as
 *   `uncertain`, never reposted by itself.
 *
 * The helper discards nothing. What it cannot post it reports, with a reason
 * from the bridge's closed list. A reason a retry may fix leaves the item
 * waiting. One it will not (Discord rejects the content, the bot may not post
 * in the channel, an outcome that can no longer be verified) has the bridge
 * set the item aside and tell the operator; it stays there until the Project
 * Master or the operator puts it back or withdraws it.
 *
 * The nonce of a claim is recorded before the claim is made, and cleared only
 * when everything it handed over has been dealt with. Until then each pass
 * asks the same claim again first, and the bridge returns the same leases. So
 * a lost answer, a pass that stopped part-way and a restart all carry on with
 * what was already handed over, without waiting for a lease to lapse.
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

/**
 * Discord's own error codes that say the chat itself will not take posts,
 * and the bridge's reason for each.
 */
const CONFIGURATION_CODES = Object.freeze({
  10003: 'chat-channel-missing',
  10004: 'chat-guild-missing',
  50001: 'chat-permission-denied',
  50013: 'chat-permission-denied'
});

/** Discord's codes for a reply whose target cannot be replied to: it is gone, or its history cannot be read. */
const REPLY_TARGET_CODES = new Set([10008, 160002]);

/**
 * The bridge's reason for a refusal that says the chat is closed to the
 * helper altogether, or null when the refusal says no such thing.
 *
 * The helper posts to one fixed channel, so what a status means there is
 * known even when Discord gives no code. A 401 is the bot's token refused. A
 * 403 is the bot not being allowed. A 404 for a post that named no message
 * to reply to can only be the channel itself. A 404 for a post that did name
 * one may be that message, which is why it is not judged here: it is tried
 * once more by itself first.
 * @param {{status: number, discordCode: (number|null)}} err - A DiscordError.
 * @param {boolean} unthreaded - Whether the refused post named no message to reply to.
 * @returns {string|null}
 */
function configurationReason(err, unthreaded) {
  const status = Number(err && err.status);
  if (status === 401) return 'chat-auth-refused';
  const coded = CONFIGURATION_CODES[err && err.discordCode];
  if (coded) return coded;
  if (status === 403) return 'chat-permission-denied';
  return status === 404 && unthreaded ? 'chat-channel-missing' : null;
}

/**
 * Whether a refused post that named a message to reply to should be tried
 * once more by itself: Discord says that message is gone or cannot be replied
 * to, or says 404 without saying what is missing.
 * @param {{status: number, discordCode: (number|null), sent: string}} err - A DiscordError.
 * @returns {boolean}
 */
function replyTargetMayBeMissing(err) {
  if (!err || err.sent !== 'no') return false;
  if (REPLY_TARGET_CODES.has(err.discordCode)) return true;
  return Number(err.status) === 404 && !CONFIGURATION_CODES[err.discordCode];
}

/** The state the operator settles by hand; a pass never retries it. */
const HELD = new Set(['uncertain']);

/** A failure that was logged where it happened. It ends the pass, and the pass has nothing to add. */
class Reported extends Error {
  constructor() {
    super('reported');
  }
}

/**
 * A settlement the operator asked for that cannot be applied. `code` says
 * why: `not-held`, `duplicate-part`, `bad-id` or `bad-settlement`.
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
   * Forget an item: the bridge has it, or has set it aside or let it go.
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
   * What a refusal from the bridge about an item means for the helper.
   *
   * `unbound`: the lease is not the helper's to use any more. The bridge says
   * nothing about the item: it may be delivered, set aside, withdrawn or
   * still waiting, and if it still waits it is handed over again. `conflict`:
   * the bridge's record of the item disagrees with the helper's. `down`: the
   * bridge did not answer, or refused for a reason that is not about the item.
   * @param {object} err - A BridgeError.
   * @returns {('unbound'|'conflict'|'down')}
   */
  function refusalKind(err) {
    const code = err && err.refusalCode;
    if (['LEASE_LAPSED', 'LEASE_NOT_FOUND', 'LEASE_NOT_YOURS'].includes(code)) return 'unbound';
    if (['ACK_MISMATCH', 'PART_MISMATCH', 'PART_ID_COLLISION', 'PART_OUT_OF_ORDER'].includes(code)) return 'conflict';
    return 'down';
  }

  /**
   * Tell the bridge an item could not be posted. Best effort for a reason a
   * retry may fix: the item waits either way. For a reason that sets the item
   * aside the report is what raises it with the operator, so a report that
   * does not land is made again on the next pass.
   * @param {object} item - The claimed item.
   * @param {object} entry - Its entry, with the parts that did post.
   * @param {string} reason - One of the bridge's failure reasons.
   * @param {number} total - How many parts the item has.
   * @returns {Promise<boolean>} Whether the bridge took the report.
   */
  async function report(item, entry, reason, total) {
    try {
      await bridge.fail(item.outboundId, item.leaseId, reason, entry.parts, total);
      return true;
    } catch (err) { // prawduct:allow prawduct/broad-except -- every failure is the client's typed BridgeError; a report that did not land is logged and made again
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status: Number(err.status) || 0 });
      log('outbound-report-failed', { outboundId: item.outboundId, status: Number(err && err.status) || 0 });
      return false;
    }
  }

  /**
   * Give the bridge one posted part's id.
   * @param {object} item - The claimed item.
   * @param {object} entry - Its entry.
   * @param {number} index - Which part.
   * @param {number} total - How many parts the item has.
   * @returns {Promise<('recorded'|'unbound')>}
   * @throws {Reported} When the bridge did not answer, or its record disagrees.
   */
  async function receipt(item, entry, index, total) {
    const id = item.outboundId;
    try {
      await bridge.part(id, item.leaseId, { index, count: total, externalId: entry.parts[index] });
      entry.receipted = Math.max(entry.receipted || 0, index + 1);
      save(id, entry);
      return 'recorded';
    } catch (err) { // prawduct:allow prawduct/broad-except -- a Reported passes through; every other failure is the client's typed BridgeError, answered below
      if (err instanceof Reported) throw err;
      const kind = refusalKind(err);
      const status = Number(err && err.status) || 0;
      if (kind === 'unbound') {
        log('outbound-ack-failed', { outboundId: id, status });
        return 'unbound';
      }
      if (kind === 'conflict') {
        // The message is in the channel and the bridge will not record it as
        // this item's. Nothing the helper does next is safe, so the item is
        // set aside for the operator and the helper lets go of it.
        log('outbound-part-conflict', { outboundId: id, part: index, status });
        if (await report(item, { parts: entry.parts.slice(0, index) }, 'part-conflict', total)) forget(id);
        throw new Reported();
      }
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('outbound-ack-failed', { outboundId: id, status });
      throw new Reported();
    }
  }

  /**
   * Seal a fully posted item under a lease.
   * @param {number} id - Outbound id.
   * @param {object} entry - Its entry, with every part posted.
   * @param {string} leaseId - The lease to acknowledge under.
   * @returns {Promise<boolean>} True when the bridge has it as delivered.
   * @throws {Reported} When the bridge could not be reached.
   */
  async function acknowledge(id, entry, leaseId) {
    try {
      await bridge.ack(id, leaseId, entry.parts);
      forget(id);
      log('outbound-acked', { outboundId: id });
      return true;
    } catch (err) { // prawduct:allow prawduct/broad-except -- a Reported passes through; every other failure is the client's typed BridgeError, answered below
      if (err instanceof Reported) throw err;
      const status = Number(err && err.status) || 0;
      const kind = refusalKind(err);
      if (kind === 'conflict') {
        // The bridge's record of the item's parts is not the helper's. The
        // helper does not seal the item on somebody else's record: it asks for
        // the item to be set aside, and lets go once the bridge has it so.
        log('outbound-part-conflict', { outboundId: id, status });
        if (await report({ outboundId: id, leaseId }, { parts: [] }, 'part-conflict', entry.parts.length)) forget(id);
        return false;
      }
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('outbound-ack-failed', { outboundId: id, status });
      if (kind === 'unbound') {
        // The lease is no longer the helper's, and the bridge says nothing of
        // the item. If the bridge already holds every part, the helper's own
        // record adds nothing: whatever became of the item, it will not be
        // posted again, and if it still waits it is handed over with its
        // parts and sealed then.
        if ((entry.receipted || 0) >= entry.parts.length) {
          forget(id);
        } else if (entry.leaseId) {
          // A lease that is no longer live never becomes usable again, so the
          // helper stops asking under it. The parts it posted stay on its
          // record, to be reported if the item is ever handed over again.
          const { leaseId: spent, ...kept } = entry;
          save(id, kept);
        }
        return false;
      }
      throw new Reported();
    }
  }

  /**
   * Post what is left of one claimed item, then acknowledge it.
   *
   * The bridge says which parts an earlier holder already posted, and the
   * helper's own record may know of one more that it posted and could not
   * report. Posting carries on after the last part either of them knows.
   * @param {object} item - A claimed item with a live lease.
   * @returns {Promise<{outcome: ('acked'|'unacked'|'held'|'skipped'), posted: boolean}>} `posted` says whether any part was sent on this call.
   * @throws {Reported} When the pass should stop.
   */
  async function relay(item) {
    const id = item.outboundId;
    const stored = entryOf(id);
    if (item.inReplyTo && item.inReplyTo.channelId !== channelId) {
      log('outbound-foreign-channel', { outboundId: id });
      return { outcome: 'skipped', posted: false };
    }
    if (typeof item.text !== 'string' || crypto.createHash('sha256').update(item.text, 'utf8').digest('hex') !== item.digest) {
      log('outbound-digest-mismatch', { outboundId: id });
      return { outcome: 'skipped', posted: false };
    }
    const parts = split(render(item));
    const total = parts.length;
    if (stored && HELD.has(stored.status)) {
      // Held here for the operator; make sure the bridge knows, so they are told.
      await report(item, stored, 'outcome-unverifiable', total);
      return { outcome: 'held', posted: false };
    }
    const atBridge = Array.isArray(item.postedParts) ? item.postedParts : [];
    const mine = stored ? stored.parts : [];
    if (atBridge.some((partId, i) => i < mine.length && mine[i] !== partId) || (item.partCount && item.partCount !== total)) {
      log('outbound-part-conflict', { outboundId: id });
      if (await report(item, { parts: [] }, 'part-conflict', total) && stored) forget(id);
      return { outcome: 'skipped', posted: false };
    }
    const entry = {
      status: 'posting', round: 0, ...(stored || {}), leaseId: item.leaseId,
      parts: mine.length >= atBridge.length ? [...mine] : [...atBridge], receipted: atBridge.length
    };
    // Anything this helper posted and could not report is reported before more is posted.
    for (let index = atBridge.length; index < entry.parts.length; index++) {
      if (await receipt(item, entry, index, total) !== 'recorded') return { outcome: 'unacked', posted: false };
    }

    let posted = false;
    while (entry.parts.length < total) {
      const part = entry.parts.length;
      if (entry.since && now() - entry.since > NONCE_WINDOW_MS) {
        save(id, { ...entry, status: 'uncertain' });
        log('outbound-uncertain', { outboundId: id, part });
        await report(item, entry, 'outcome-unverifiable', total);
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
      const replyTo = part === 0 && item.inReplyTo ? item.inReplyTo.externalId : null;
      let unthreaded = !replyTo;
      try {
        const message = { content: parts[part], nonce: nonceFor(state.salt, id, part, entry.round) };
        try {
          made = await rest.createMessage(channelId, { ...message, replyTo });
        } catch (err) { // prawduct:allow prawduct/broad-except -- only one typed refusal is answered here; everything else is thrown on to the handler below
          // The message this answers may be gone. That is not the channel
          // being broken: the answer is posted by itself, once. If that is
          // refused too, the refusal is judged as an unthreaded post's.
          if (unthreaded || !replyTargetMayBeMissing(err)) throw err;
          log('outbound-reply-target-missing', { outboundId: id });
          unthreaded = true;
          made = await rest.createMessage(channelId, { ...message, replyTo: null });
        }
      } catch (err) { // prawduct:allow prawduct/broad-except -- every post failure is the client's typed DiscordError, answered below
        const status = Number(err && err.status) || 0;
        const notSent = err && err.sent === 'no';
        if (notSent && opened) {
          delete entry.since;
          save(id, entry);
        }
        log('outbound-post-failed', { outboundId: id, status });
        if (notSent && opened && status === 400) {
          // Discord refused this item's own content, and would again. The
          // bridge sets it aside and tells the operator; the helper lets go.
          log('outbound-rejected', { outboundId: id, part });
          if (await report(item, entry, 'rejected-by-chat', total)) forget(id);
          return { outcome: 'held', posted };
        }
        if (notSent && !opened && status === 400) {
          // A refusal now does not settle an earlier attempt that may have landed.
          save(id, { ...entry, status: 'uncertain' });
          log('outbound-uncertain', { outboundId: id, part });
          await report(item, entry, 'outcome-unverifiable', total);
          return { outcome: 'held', posted };
        }
        const closed = notSent && opened ? configurationReason(err, unthreaded) : null;
        if (closed) {
          // Discord says the chat is closed to the helper altogether. The
          // bridge sets this item aside, stops handing anything over, and
          // tells the operator once; the helper stops here.
          log('outbound-chat-closed', { outboundId: id, status });
          if (await report(item, entry, closed, total)) forget(id);
          throw new Reported();
        }
        if (notSent && opened && status >= 400 && status < 500 && status !== 429) {
          // A refusal the helper cannot place: not the item's content, not
          // the channel, not a rate limit. It is not retried on a guess and
          // never counted as posted: the item is set aside for the operator.
          if (await report(item, entry, 'outcome-unverifiable', total)) forget(id);
          return { outcome: 'held', posted };
        }
        await report(item, entry, notSent ? 'transient' : 'outcome-unknown', total);
        throw new Reported();
      }
      posted = true;
      entry.parts.push(made.id);
      delete entry.since;
      if (entry.parts.length === total) entry.status = 'posted';
      // If this write fails the part stays on the entry this process holds,
      // so it is not posted again while the helper runs.
      save(id, entry);
      log('outbound-posted', { outboundId: id, part });
      if (await receipt(item, entry, part, total) !== 'recorded') return { outcome: 'unacked', posted };
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
      if (err && err.refusalCode === 'BRIDGE_CONFIGURATION_BLOCKED') {
        // The bridge hands nothing over until its configuration circuit is
        // reset. Asking changes nothing there; the helper waits and asks again.
        log('bridge-configuration-blocked', { status });
        throw new Reported();
      }
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
 * Settle an item held as `uncertain` with what the operator saw in the
 * channel. Run with the helper stopped.
 *
 * The part in doubt either posted (`posted`: its Discord id is recorded and
 * the relay goes on from the next part) or did not (`repost`: it is posted
 * again, under a new nonce). The bridge set the item aside when it was held,
 * so it moves again only once the Project Master or the operator has put it
 * back.
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
    if (typeof finding.posted !== 'string' || !/^\d{15,20}$/.test(finding.posted)) throw new SettleError('bad-id');
    if (entry.parts.includes(finding.posted)) throw new SettleError('duplicate-part');
    next.parts.push(finding.posted);
  } else {
    next.round = (entry.round || 0) + 1;
  }
  state.set(id, next);
  return { part: next.parts.length + 1 };
}

module.exports = { createOutbound, settleHeld, configurationReason, replyTargetMayBeMissing, CONFIGURATION_CODES, REPLY_TARGET_CODES, render, split, Reported, SettleError, HELD, PART_MAX, NONCE_WINDOW_MS, LEASE_MARGIN_MS };
