import { loadConventions } from '../../config/index.js';
import { isPlaceholderId, resolveChannelContext } from '../../config/resolver.js';
import { pendingClientMessages } from '../../thread-context/index.js';
import { isProcessableMessage } from './message.js';

/**
 * Watches CLIENT-EXTERNAL channels (`{key}-pixelup`) for unanswered client
 * messages, so `schedules/response-watchdog.js` can nudge the team in the
 * client's INTERNAL channel after
 * `conventions.client_response_watchdog.threshold_hours` of silence.
 *
 * Deterministic, no model call, and this module never posts anywhere itself —
 * it only updates `pendingClientMessages`, which the scheduler reads. That
 * keeps it inside the "bot never speaks in a client channel" rule: watching a
 * channel is not the same as speaking in it.
 *
 * "Team member" is decided by `conventions.users` (the same roster every
 * other permission check uses) — anyone else posting in the channel is
 * treated as the client (or a client-side guest), and any team-member message
 * anywhere in the channel — top-level or in a thread — clears the pending
 * entry.
 *
 * A team member can also acknowledge without replying: reacting with one of
 * `ack_emoji` on the tracked client message (`handleClientResponseAck`,
 * driven by `reaction_added`) clears the entry the same way a reply would.
 * Matched by the reacted-to message's own ts against the entry's
 * `firstMessageTs`/`latestMessageTs` — never "any reaction in the channel" —
 * so reacting to something unrelated (an old message, a team member's own
 * message) never clears a pending reminder it wasn't about.
 */

const SNIPPET_MAX_CHARS = 200;

/** Reaction names (Slack's canonical `name`, no colons) that count as "acknowledged". */
const DEFAULT_ACK_EMOJI = ['+1', 'thumbsup', 'white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'];

/**
 * @param {string} text
 * @returns {string}
 */
function snippet(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > SNIPPET_MAX_CHARS ? `${clean.slice(0, SNIPPET_MAX_CHARS)}…` : clean;
}

/**
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleClientResponseWatchdog({ client, event, logger }) {
  try {
    const conventions = loadConventions();
    const watchdog = conventions.client_response_watchdog;
    if (!watchdog || watchdog.enabled === false) return;

    const e = /** @type {any} */ (event);
    if (!isProcessableMessage(e)) return;
    if (e.bot_id) return; // Only a real person moves the clock, in either direction.
    if (!e.channel || !e.user) return;

    const ctx = await resolveChannelContext({ client, conventions, channelId: e.channel });
    if (ctx.kind !== 'client-external' || !ctx.clientKey) return;

    if (conventions.users[e.user]) {
      const pending = pendingClientMessages.get(e.channel);
      if (pending) {
        const waitedMin = Math.round((Date.now() - pending.firstSeenAt) / 60000);
        logger.info(`Response watchdog cleared for ${ctx.clientKey} — team reply after ${waitedMin}m unanswered.`);
      }
      pendingClientMessages.clearChannel(e.channel);
      return;
    }

    // A client (or client-side guest) posted. Only track it if there is
    // somewhere to send a reminder — an unregistered client, or one with no
    // internal_channel_id configured, has no destination.
    const internalChannelId = conventions.clients[ctx.clientKey]?.internal_channel_id;
    if (isPlaceholderId(internalChannelId)) return;

    const isNewEntry = !pendingClientMessages.get(e.channel);
    pendingClientMessages.recordClientMessage(e.channel, {
      clientKey: ctx.clientKey,
      messageTs: e.ts,
      snippet: snippet(e.text || '') || (e.files?.length ? '[attachment, no text]' : ''),
    });
    if (isNewEntry) {
      logger.info(`Response watchdog started tracking ${ctx.clientKey} in ${e.channel} (clock starts now).`);
    }
  } catch (err) {
    logger.error(`Client response watchdog tracking failed: ${err}`);
  }
}

/**
 * A team member reacting with an ack emoji (thumbs-up, check mark, …) on the
 * tracked client message counts as acknowledged — the same as replying —
 * and clears the pending entry so no reminder fires for it.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'reaction_added'>} args
 * @returns {Promise<void>}
 */
export async function handleClientResponseAck({ client, event, logger }) {
  try {
    const conventions = loadConventions();
    const watchdog = conventions.client_response_watchdog;
    if (!watchdog || watchdog.enabled === false) return;

    const e = /** @type {any} */ (event);
    if (e.item?.type !== 'message' || !e.item.channel || !e.item.ts || !e.user || !e.reaction) return;

    // Only a configured team member's reaction counts as an acknowledgement —
    // the client reacting to their own message doesn't mean anything.
    if (!conventions.users[e.user]) return;

    const ackEmoji = new Set(watchdog.ack_emoji || DEFAULT_ACK_EMOJI);
    if (!ackEmoji.has(e.reaction)) return;

    const pending = pendingClientMessages.get(e.item.channel);
    if (!pending) return;

    // Only the tracked client message(s) — not just any reaction anywhere in
    // the channel — counts, so an unrelated reaction can never clear a
    // reminder it wasn't about.
    if (e.item.ts !== pending.firstMessageTs && e.item.ts !== pending.latestMessageTs) return;

    const ctx = await resolveChannelContext({ client, conventions, channelId: e.item.channel });
    if (ctx.kind !== 'client-external' || !ctx.clientKey) return;

    const waitedMin = Math.round((Date.now() - pending.firstSeenAt) / 60000);
    pendingClientMessages.clearChannel(e.item.channel);
    logger.info(
      `Response watchdog acknowledged via :${e.reaction}: for ${ctx.clientKey} — cleared after ${waitedMin}m unanswered.`,
    );
  } catch (err) {
    logger.error(`Client response watchdog ack tracking failed: ${err}`);
  }
}
