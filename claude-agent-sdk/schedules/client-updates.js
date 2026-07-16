import { runPixelupAgent } from '../agent/index.js';
import { loadConventions } from '../config/index.js';

/**
 * Tue/Fri client update drafts. A minute-tick scheduler (no cron dependency)
 * compares wall-clock time in the configured timezone against the schedule
 * and, on a match, asks the agent to draft each client's update. The agent's
 * propose_client_update tool posts the draft to the internal drafts channel
 * with an approve button — a human signs off and sends it. Nothing ever
 * reaches a client from here.
 */

const TICK_MS = 60 * 1000;

/**
 * Wall-clock parts for a date in a timezone.
 * @param {Date} date
 * @param {string} timezone
 * @returns {{ weekday: string, hour: number, minute: number, dateKey: string }}
 */
export function zonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    weekday: parts.weekday.toLowerCase(),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Should the scheduled run fire for this tick?
 * @param {{ weekday: string, hour: number, minute: number, dateKey: string }} parts
 * @param {{ enabled: boolean, days: string[], hour: number, minute: number }} schedule
 * @param {string | null} lastRunKey - dateKey of the last fired run.
 * @returns {boolean}
 */
export function shouldRun(parts, schedule, lastRunKey) {
  if (!schedule.enabled) return false;
  if (!schedule.days.includes(parts.weekday)) return false;
  if (parts.hour !== schedule.hour || parts.minute !== schedule.minute) return false;
  return lastRunKey !== parts.dateKey;
}

/**
 * Draft updates for every configured client by running the agent once per
 * client. Costs tokens only when it actually fires (twice a week).
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ info: Function, error: Function }} logger
 * @returns {Promise<void>}
 */
export async function runClientUpdateDrafts(client, logger) {
  const conventions = loadConventions();
  const draftsChannel = conventions.channels.drafts_channel_id;
  if (!draftsChannel) {
    logger.error('Client update run skipped: channels.drafts_channel_id is not set in conventions.');
    return;
  }

  // A lead from config "owns" scheduled drafts so the lead-only gate on
  // propose_client_update passes; approval still happens on the card.
  const leadId = Object.entries(conventions.users).find(([, user]) => user.role === 'lead')?.[0];
  if (!leadId) {
    logger.error('Client update run skipped: no lead in conventions users.');
    return;
  }

  for (const [clientKey, clientConfig] of Object.entries(conventions.clients)) {
    try {
      const prompt =
        `Scheduled client update run. Draft this week's update for client "${clientKey}" ` +
        `(${clientConfig.display_name}): review their project status in ClickUp and recent internal ` +
        'channel context, write the update in the agency voice, then call propose_client_update. ' +
        'Do not ask questions — if there is too little activity to draft, say so briefly instead.';
      const deps = {
        client,
        userId: leadId,
        channelId: draftsChannel,
        threadTs: '',
        messageTs: '',
      };
      await runPixelupAgent(prompt, undefined, deps);
      logger.info(`Client update draft run completed for ${clientKey}.`);
    } catch (e) {
      logger.error(`Client update draft failed for ${clientKey}: ${e}`);
    }
  }
}

/**
 * Start the scheduler. Returns the interval handle, or null when disabled —
 * the app runs fine without it (e.g. before config/keys are in place).
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ info: Function, error: Function }} logger
 * @returns {NodeJS.Timeout | null}
 */
export function startClientUpdateScheduler(client, logger) {
  const conventions = loadConventions();
  const schedule = conventions.client_updates;
  if (!schedule.enabled) {
    logger.info('Client update scheduler disabled (client_updates.enabled is false).');
    return null;
  }

  /** @type {string | null} */
  let lastRunKey = null;

  const handle = setInterval(() => {
    try {
      const parts = zonedParts(new Date(), schedule.timezone);
      if (shouldRun(parts, schedule, lastRunKey)) {
        lastRunKey = parts.dateKey;
        void runClientUpdateDrafts(client, logger);
      }
    } catch (e) {
      logger.error(`Client update scheduler tick failed: ${e}`);
    }
  }, TICK_MS);
  handle.unref?.();
  logger.info(
    `Client update scheduler started (${schedule.days.join('/')} ${schedule.hour}:${String(schedule.minute).padStart(2, '0')} ${schedule.timezone}).`,
  );
  return handle;
}
