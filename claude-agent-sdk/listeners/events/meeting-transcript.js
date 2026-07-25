import { summarizeMeeting } from '../../agent/meeting-summary.js';
import { loadConventions } from '../../config/index.js';

/**
 * Meeting-transcript automation.
 *
 * Fireflies drops a client-call transcript into the configured
 * `#meeting-transcripts` channel as two messages: a parent (Title / Date /
 * Participants + highlights) and a thread reply (Notes + Action Items). This
 * listener triggers on the reply, identifies which client the meeting was for,
 * asks the agent for a concise to-do-focused recap, and posts it to THAT
 * client's INTERNAL channel — never the client-facing channel.
 *
 * Internal team meetings (standups, syncs) have only internal participants and
 * are ignored. Client identification and the destination channel are resolved
 * in code (from config), so the model can never target a client channel.
 */

// Remember threads we've already summarized so a Fireflies edit/repeat of the
// notes message doesn't post a second recap. Capped, same tradeoffs as the
// session store.
const PROCESSED_MAX = 500;
/** @type {Set<string>} */
const processed = new Set();

/** @param {string} key @returns {void} */
function remember(key) {
  processed.add(key);
  if (processed.size > PROCESSED_MAX) {
    const oldest = processed.values().next().value;
    if (oldest !== undefined) processed.delete(oldest);
  }
}

/** Test hook: clear the processed set. @returns {void} */
export function resetProcessed() {
  processed.clear();
}

/** @param {string | undefined} value @returns {boolean} Real Slack channel ID. */
function looksLikeChannelId(value) {
  return /^[CDG][A-Z0-9]{5,}$/.test(value || '');
}

/** @param {string} email @returns {string} */
function domainOf(email) {
  return (email.split('@')[1] || '').trim().toLowerCase();
}

/**
 * Pull Title and Participants from a Fireflies transcript header message.
 * @param {string} text
 * @returns {{ title: string, participantEmails: string[] }}
 */
export function parseTranscriptHeader(text) {
  let title = '';
  /** @type {string[]} */
  let participantEmails = [];
  for (const line of (text || '').split('\n')) {
    const titleMatch = line.match(/^\s*Title:\s*(.+)$/i);
    if (titleMatch) title = titleMatch[1].trim();
    const participantsMatch = line.match(/^\s*Participants:\s*(.+)$/i);
    if (participantsMatch) {
      participantEmails = participantsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.includes('@'));
    }
  }
  return { title, participantEmails };
}

/**
 * True when a message is the Notes / Action Items reply (the trigger message),
 * as opposed to the header parent.
 * @param {string} text
 * @returns {boolean}
 */
export function isNotesMessage(text) {
  return /action items/i.test(text || '');
}

/**
 * A meeting with at least one participant outside the agency's own domains is a
 * client call; all-internal participant lists are standups/syncs we ignore.
 * @param {{ participantEmails: string[] }} header
 * @param {string[]} internalDomains
 * @returns {boolean}
 */
export function hasExternalParticipant(header, internalDomains) {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()));
  return header.participantEmails.some((email) => {
    const domain = domainOf(email);
    return domain !== '' && !internal.has(domain);
  });
}

/** @param {string} title @param {string} name @returns {boolean} whole-word, case-insensitive. */
function titleHasName(title, name) {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(title);
}

/**
 * Match a transcript to a configured client: first by name in the title
 * (display_name or an alias — longest match wins), then by a participant email
 * domain. Returns null when nothing matches (e.g. an unknown external party).
 * @param {import('../../config/index.js').Conventions} conventions
 * @param {{ title: string, participantEmails: string[] }} header
 * @returns {{ key: string, client: import('../../config/index.js').ClientConfig } | null}
 */
export function matchClientForMeeting(conventions, header) {
  /** @type {{ key: string, client: any, length: number } | null} */
  let best = null;
  for (const [key, client] of Object.entries(conventions.clients)) {
    const names = [client.display_name, ...(client.aliases || [])].filter(Boolean);
    for (const name of names) {
      if (titleHasName(header.title, name) && (!best || name.length > best.length)) {
        best = { key, client, length: name.length };
      }
    }
  }
  if (best) return { key: best.key, client: best.client };

  const domains = header.participantEmails.map(domainOf);
  for (const [key, client] of Object.entries(conventions.clients)) {
    const clientDomains = (client.email_domains || []).map((d) => d.toLowerCase());
    if (clientDomains.some((d) => domains.includes(d))) return { key, client };
  }
  return null;
}

/**
 * Handle a message in the meeting-transcripts channel.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @param {{ summarize?: typeof summarizeMeeting }} [injected] - Test seam for the summarizer.
 * @returns {Promise<void>}
 */
export async function handleMeetingTranscript(args, injected = {}) {
  const { client, event, logger } = args;
  const summarize = injected.summarize || summarizeMeeting;
  try {
    const conventions = loadConventions();
    const cfg = conventions.meeting_transcripts;
    // Disabled or unconfigured → no-op (same posture as the client-update scheduler).
    if (!cfg || cfg.enabled === false || !looksLikeChannelId(cfg.channel_id)) return;

    const e = /** @type {any} */ (event);
    if (e.channel !== cfg.channel_id) return;
    // Only fresh bot posts — skip human chatter, edits, deletes, joins.
    if (e.subtype !== undefined && e.subtype !== 'bot_message') return;
    if (!e.bot_id && e.subtype !== 'bot_message') return;

    // Trigger on the Notes / Action Items reply, which arrives after the header.
    if (!isNotesMessage(e.text || '')) return;

    const threadTs = e.thread_ts || e.ts;
    const dedupeKey = `${e.channel}:${threadTs}`;
    if (processed.has(dedupeKey)) return;

    // Fetch the thread so we have the header (parent) for client identification.
    const replies = await client.conversations.replies({ channel: e.channel, ts: threadTs, limit: 30 });
    const messages = replies.messages || [];
    const header = parseTranscriptHeader(messages[0]?.text || '');

    // Not actually a Fireflies transcript (no header) — ignore silently.
    if (!header.title || header.participantEmails.length === 0) return;

    const internalDomains = cfg.internal_email_domains?.length ? cfg.internal_email_domains : ['pixelup.in'];
    // Internal team meeting (standup/sync) → ignore, per the requirement.
    if (!hasExternalParticipant(header, internalDomains)) {
      logger.info(`Meeting transcript ignored — internal meeting "${header.title}".`);
      return;
    }

    const match = matchClientForMeeting(conventions, header);
    remember(dedupeKey);

    if (!match) {
      await client.chat.postMessage({
        channel: e.channel,
        thread_ts: threadTs,
        text: `:grey_question: I couldn't match this meeting ("${header.title}") to a known client, so I didn't route a recap. Add an \`aliases\` or \`email_domains\` entry in config if it should map to one.`,
      });
      logger.info(`Meeting transcript unmatched — "${header.title}".`);
      return;
    }

    const internalChannel = match.client.internal_channel_id;
    // Hard rule: never post to a client-facing channel. Post only to the
    // resolved internal channel; if it's missing (or somehow equals the client
    // channel), flag it in-thread rather than guess.
    if (!looksLikeChannelId(internalChannel) || internalChannel === match.client.channel_id) {
      await client.chat.postMessage({
        channel: e.channel,
        thread_ts: threadTs,
        text: `:warning: Meeting matched *${match.client.display_name}*, but no internal channel is configured (\`clients.${match.key}.internal_channel_id\`). Set it and I'll auto-post recaps there.`,
      });
      logger.info(`Meeting transcript matched ${match.key} but has no internal channel.`);
      return;
    }

    const notesText = messages.find((m) => isNotesMessage(m.text || ''))?.text || e.text || '';
    const recap = await summarize({
      displayName: match.client.display_name,
      title: header.title,
      headerText: messages[0]?.text || '',
      notesText,
    });
    if (!recap?.trim()) {
      logger.error(`Meeting recap for ${match.key} came back empty — nothing posted.`);
      return;
    }

    await client.chat.postMessage({
      channel: /** @type {string} */ (internalChannel),
      text: recap,
      unfurl_links: false,
      unfurl_media: false,
    });
    logger.info(`Posted meeting recap for ${match.key} to its internal channel.`);
  } catch (err) {
    logger.error(`Meeting transcript handler failed: ${err}`);
  }
}
