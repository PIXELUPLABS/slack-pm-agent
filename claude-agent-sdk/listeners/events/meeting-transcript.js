import { summarizeMeeting, summarizeStandup } from '../../agent/meeting-summary.js';
import { loadConventions } from '../../config/index.js';
import { canBotPostInChannel } from '../../config/resolver.js';

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
 * Slack's wire format is NOT what you see in the client. Fireflies posts its
 * header with bold labels and auto-linked emails, so `event.text` actually
 * arrives as:
 *
 *   *Title:* <https://app.fireflies.ai/view/x|Acme <> PIXELUP Weekly Sync>
 *   *Participants:* <mailto:a@acme.com|a@acme.com>, <mailto:b@pixelup.in|b@pixelup.in>
 *
 * Slack may preserve those fields as separate lines, or flatten the entire
 * header into one line even though the client renders it as separate blocks.
 * Normalize the markup away first: unwrap mailto links to the bare address,
 * drop URLs and the surrounding `<`/`>`/`|`, and strip bold/italic markers.
 * Lossy by design — the title only needs to survive well enough to match a
 * client name.
 * @param {string} text
 * @returns {string}
 */
export function normalizeSlackText(text) {
  return (text || '')
    .split('\n')
    .map((line) =>
      line
        // <mailto:a@b.com|a@b.com> and <mailto:a@b.com> → a@b.com
        .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/gi, '$1')
        // Drop URLs entirely; the label text after "|" is what we want. Stop at
        // "|" and ">" — a greedy \S+ would eat the pipe and the first word of
        // the label, silently dropping the client name out of the title.
        .replace(/https?:\/\/[^\s|>]+/gi, ' ')
        // Leftover link scaffolding, including the `<>` in "Acme <> PIXELUP".
        .replace(/[<>|]/g, ' ')
        // Bold/italic/strike markers around labels and values.
        .replace(/[*_~`]/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .join('\n');
}

/**
 * Pull Title and Participants from a Fireflies transcript header message.
 * @param {string} text
 * @returns {{ title: string, participantEmails: string[] }}
 */
export function parseTranscriptHeader(text) {
  // Parse the normalized header as one stream. This handles both the original
  // newline-delimited shape and Fireflies' current Slack payload, where Title,
  // Date, Participants, and every highlight field arrive on one line.
  const normalized = normalizeSlackText(text).replace(/\s+/g, ' ').trim();
  const titleMatch = normalized.match(/(?:^|\s)Title\s*:\s*(.*?)(?=\s+(?:Date|Participants)\s*:|$)/i);
  const title = titleMatch?.[1]?.trim() || '';

  /** @type {string[]} */
  let participantEmails = [];
  const participantsMatch = normalized.match(/(?:^|\s)Participants\s*:\s*/i);
  if (participantsMatch?.index !== undefined) {
    const afterLabel = normalized.slice(participantsMatch.index + participantsMatch[0].length);
    // A Fireflies highlight follows the email list as another Title Case label
    // (`Brand Refresh:`, `Copy Approval Delays:`, …). Keep malformed list text
    // for validation, but stop before those later fields so an email mentioned
    // in a highlight cannot be mistaken for a participant.
    const nextField = afterLabel.search(/\s+[A-Z][A-Za-z0-9 &'()/-]{1,60}\s*:/);
    const participantText = nextField >= 0 ? afterLabel.slice(0, nextField) : afterLabel;
    participantEmails = participantText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
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
 * Titles that are never client calls (standups, retros, all-hands…).
 *
 * Both the title and the patterns are squashed to lowercase alphanumerics before
 * comparing, so one pattern covers every spelling: `standup` matches "Daily
 * Stand Up", "Daily Stand-Up", and "DailyStandup".
 *
 * The patterns live in config precisely because this needs judgement: a bare
 * "sync" would wrongly swallow real client calls, which are named
 * "<Client> <> PIXELUP Weekly Sync". Keep additions specific.
 * @param {string} title
 * @param {string[] | undefined} patterns
 * @returns {string | null} The pattern that matched, or null.
 */
export function ignoredTitlePattern(title, patterns) {
  const haystack = squashTitle(title);
  if (!haystack) return null;
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const needle = squashTitle(pattern);
    if (needle && haystack.includes(needle)) return pattern;
  }
  return null;
}

/** @param {string | undefined} title @returns {string} */
function squashTitle(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The one internal ceremony that is routed instead of ignored. Keep this
 * narrower than the generic `standup` ignore pattern: only the daily standup
 * belongs in #daily-updates.
 * @param {string} title
 * @returns {boolean}
 */
export function isDailyStandupTitle(title) {
  const squashed = squashTitle(title);
  return squashed.includes('daily') && squashed.includes('standup');
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
 * @param {{ summarize?: typeof summarizeMeeting, summarizeStandup?: typeof summarizeStandup }} [injected] - Test seams for the summarizers.
 * @returns {Promise<void>}
 */
export async function handleMeetingTranscript(args, injected = {}) {
  const { client, event, logger } = args;
  const summarize = injected.summarize || summarizeMeeting;
  const summarizeDailyStandup = injected.summarizeStandup || summarizeStandup;
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

    const notesText = messages.find((m) => isNotesMessage(m.text || ''))?.text || e.text || '';
    const internalDomains = cfg.internal_email_domains?.length ? cfg.internal_email_domains : ['pixelup.in'];

    // The internal daily standup is the one ceremony we route: its action items
    // go to #daily-updates. Requiring an all-internal participant list keeps a
    // client's own daily standup out of the agency-wide updates channel.
    if (isDailyStandupTitle(header.title) && !hasExternalParticipant(header, internalDomains)) {
      const standupChannel = cfg.standup_channel_id;
      remember(dedupeKey);
      if (!looksLikeChannelId(standupChannel)) {
        await client.chat.postMessage({
          channel: e.channel,
          thread_ts: threadTs,
          text: ':warning: Daily standup detected, but `meeting_transcripts.standup_channel_id` is not configured.',
        });
        logger.error('Daily standup action items not routed — standup_channel_id is missing.');
        return;
      }
      const standupChannelId = /** @type {string} */ (standupChannel);
      const target = await canBotPostInChannel({
        client,
        conventions,
        channelId: standupChannelId,
      });
      if (!target.allowed) {
        logger.error(`Daily standup action items not routed — ${target.reason}.`);
        return;
      }
      const actionItems = await summarizeDailyStandup({
        title: header.title,
        headerText: messages[0]?.text || '',
        notesText,
      });
      if (!actionItems?.trim()) {
        logger.error('Daily standup action-item summary came back empty — nothing posted.');
        return;
      }
      await client.chat.postMessage({
        channel: standupChannelId,
        text: actionItems,
        unfurl_links: false,
        unfurl_media: false,
      });
      logger.info(`Posted daily standup action items to ${standupChannelId}.`);
      return;
    }

    // Other title exclusions still win over the participant check.
    const ignoredBy = ignoredTitlePattern(header.title, cfg.ignore_title_patterns);
    if (ignoredBy) {
      logger.info(`Meeting transcript ignored — title "${header.title}" matches "${ignoredBy}".`);
      return;
    }

    // Internal team meeting (everyone on our own domains) → ignore.
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
