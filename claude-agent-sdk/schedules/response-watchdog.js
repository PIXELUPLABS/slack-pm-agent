import { loadConventions } from '../config/index.js';
import { isPlaceholderId } from '../config/resolver.js';
import { pendingClientMessages } from '../thread-context/index.js';

/**
 * Nudges the team when a client message in a `{key}-pixelup` channel has gone
 * unanswered for `conventions.client_response_watchdog.threshold_hours`.
 *
 * Tracking happens on every message in
 * `listeners/events/client-response-watchdog.js`; this is a minute-tick
 * scheduler (same shape as `client-updates.js`, no cron dependency) that polls
 * that in-memory state and, when a pending entry is due, posts to the
 * CLIENT'S INTERNAL channel — never the client-facing one it was raised in.
 * No model call: the reminder text is built from data alone.
 *
 * Fires again every `threshold_hours` while still unanswered (the clock is
 * `lastAlertAt || firstSeenAt`), not just once, and stops as soon as a team
 * member replies — that reply clears the pending entry in the tracker.
 */

const TICK_MS = 60 * 1000;

/**
 * @param {{ firstSeenAt: number, lastAlertAt: number }} entry
 * @param {number} thresholdHours
 * @param {number} now
 * @returns {boolean}
 */
export function isDue(entry, thresholdHours, now) {
  const anchor = entry.lastAlertAt || entry.firstSeenAt;
  return now - anchor >= thresholdHours * 60 * 60 * 1000;
}

/**
 * @param {{ entry: { firstSeenAt: number, alertCount: number, snippet: string }, channelId: string, displayName: string, permalink: string, now?: number }} args
 * @returns {string}
 */
export function buildReminderText({ entry, channelId, displayName, permalink, now = Date.now() }) {
  const hoursWaiting = Math.floor((now - entry.firstSeenAt) / (60 * 60 * 1000));
  const lead = entry.alertCount > 0 ? 'Still no reply' : 'No reply yet';
  const quoted = entry.snippet ? `\n> ${entry.snippet}` : '';
  const link = permalink ? `\n<${permalink}|Jump to message>` : '';
  return (
    `:alarm_clock: <!here> *${displayName}* has been waiting *${hoursWaiting}h* for a reply in <#${channelId}> ` +
    `(${lead}).${quoted}${link}`
  );
}

/**
 * Check every pending entry and alert the ones that are due.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ info: Function, error: Function }} logger
 * @returns {Promise<void>}
 */
export async function checkPendingClientMessages(client, logger) {
  const conventions = loadConventions();
  const watchdog = conventions.client_response_watchdog;
  if (!watchdog || watchdog.enabled === false) return;
  const thresholdHours = watchdog.threshold_hours ?? 8;

  for (const [channelId, entry] of pendingClientMessages.entries()) {
    if (!isDue(entry, thresholdHours, Date.now())) continue;

    const clientConfig = conventions.clients[entry.clientKey];
    const internalChannelId = clientConfig?.internal_channel_id;
    if (isPlaceholderId(internalChannelId)) {
      // Config changed out from under a pending entry — nowhere to alert into.
      pendingClientMessages.clearChannel(channelId);
      continue;
    }

    try {
      let permalink = '';
      try {
        const res = await client.chat.getPermalink({ channel: channelId, message_ts: entry.latestMessageTs });
        permalink = /** @type {any} */ (res)?.permalink || '';
      } catch {
        // Permalink is a nice-to-have; the reminder still works without it.
      }

      const text = buildReminderText({
        entry,
        channelId,
        displayName: clientConfig.display_name || entry.clientKey,
        permalink,
      });

      await client.chat.postMessage({
        channel: /** @type {string} */ (internalChannelId),
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      pendingClientMessages.markAlerted(channelId);
      logger.info(`Response watchdog reminder sent for ${entry.clientKey}.`);
    } catch (e) {
      logger.error(`Response watchdog reminder failed for ${entry.clientKey}: ${e}`);
    }
  }
}

/**
 * Start the scheduler. Returns the interval handle, or null when disabled.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ info: Function, error: Function }} logger
 * @returns {NodeJS.Timeout | null}
 */
export function startResponseWatchdogScheduler(client, logger) {
  const conventions = loadConventions();
  const watchdog = conventions.client_response_watchdog;
  if (!watchdog || watchdog.enabled === false) {
    logger.info('Client response watchdog disabled (client_response_watchdog.enabled is false).');
    return null;
  }

  const handle = setInterval(() => {
    void checkPendingClientMessages(client, logger).catch((e) => logger.error(`Response watchdog tick failed: ${e}`));
  }, TICK_MS);
  handle.unref?.();
  logger.info(`Client response watchdog started (threshold ${watchdog.threshold_hours ?? 8}h, checked every minute).`);
  return handle;
}
