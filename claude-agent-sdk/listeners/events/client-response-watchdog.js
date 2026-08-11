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
 */

const SNIPPET_MAX_CHARS = 200;

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
      pendingClientMessages.clearChannel(e.channel);
      return;
    }

    // A client (or client-side guest) posted. Only track it if there is
    // somewhere to send a reminder — an unregistered client, or one with no
    // internal_channel_id configured, has no destination.
    const internalChannelId = conventions.clients[ctx.clientKey]?.internal_channel_id;
    if (isPlaceholderId(internalChannelId)) return;

    pendingClientMessages.recordClientMessage(e.channel, {
      clientKey: ctx.clientKey,
      messageTs: e.ts,
      snippet: snippet(e.text || '') || (e.files?.length ? '[attachment, no text]' : ''),
    });
  } catch (err) {
    logger.error(`Client response watchdog tracking failed: ${err}`);
  }
}
