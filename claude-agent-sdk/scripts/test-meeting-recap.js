import 'dotenv/config';
import { WebClient } from '@slack/web-api';

import { summarizeMeeting } from '../agent/meeting-summary.js';
import { loadConventions } from '../config/index.js';
import {
  hasExternalParticipant,
  ignoredTitlePattern,
  isNotesMessage,
  matchClientForMeeting,
  parseTranscriptHeader,
} from '../listeners/events/meeting-transcript.js';

/**
 * Dry-run the meeting-transcript automation against a REAL Fireflies thread.
 *
 * Replays the exact pipeline the listener runs — same parsing, same gates, same
 * summarizer — but prints every decision and the recap instead of posting, so a
 * transcript can be checked end to end without spamming an internal channel.
 *
 *   node scripts/test-meeting-recap.js                    # newest transcript thread
 *   node scripts/test-meeting-recap.js <slack-permalink>  # a specific thread
 *   node scripts/test-meeting-recap.js <thread-ts>
 *
 * Flags:
 *   --gates-only  Stop before the model call (no ANTHROPIC_API_KEY needed, no cost).
 *   --post        Actually post the recap to the resolved internal channel.
 *
 * Requires SLACK_BOT_TOKEN (app settings → OAuth & Permissions → Bot User OAuth
 * Token); the bot must be in the transcripts channel. --post additionally needs
 * it to be in the client's internal channel.
 */

/** @param {string | undefined} value */
const looksLikeChannelId = (value) => /^[CDG][A-Z0-9]{5,}$/.test(value || '');

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('SLACK_BOT_TOKEN is not set. Copy the Bot User OAuth Token from app settings → OAuth & Permissions.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const gatesOnly = argv.includes('--gates-only');
const post = argv.includes('--post');
const target = argv.find((a) => !a.startsWith('--'));

const conventions = loadConventions();
const cfg = conventions.meeting_transcripts;
if (!cfg || cfg.enabled === false || !looksLikeChannelId(cfg.channel_id)) {
  console.error('meeting_transcripts is disabled or has no valid channel_id in config/conventions.json.');
  process.exit(1);
}
const transcriptsChannel = /** @type {string} */ (cfg.channel_id);
const client = new WebClient(token);

/** @param {string} label @param {string} detail */
const pass = (label, detail) => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
/** @param {string} label @param {string} detail */
const stop = (label, detail) => {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  console.log('\nPipeline stops here. Nothing would be posted to an internal channel.');
  process.exit(0);
};

/**
 * A permalink's `p1752480000123456` is the ts with the dot removed.
 * @param {string} value
 * @returns {string | null}
 */
function parseThreadTs(value) {
  const link = value.match(/\/archives\/[CDG][A-Z0-9]+\/p(\d{10})(\d{6})/);
  if (link) return `${link[1]}.${link[2]}`;
  if (/^\d{10}\.\d{6}$/.test(value)) return value;
  return null;
}

/**
 * Newest thread in the transcripts channel that has a notes/action-items reply.
 * @returns {Promise<string | null>}
 */
async function findLatestTranscriptThread() {
  const history = await client.conversations.history({ channel: transcriptsChannel, limit: 30 });
  for (const message of history.messages || []) {
    const ts = message.thread_ts || message.ts;
    if (!ts) continue;
    if (isNotesMessage(message.text || '')) return ts;
    if (!message.reply_count) continue;
    const replies = await client.conversations.replies({ channel: transcriptsChannel, ts, limit: 30 });
    if ((replies.messages || []).some((m) => isNotesMessage(m.text || ''))) return ts;
  }
  return null;
}

const threadTs = target ? parseThreadTs(target) : await findLatestTranscriptThread();
if (target && !threadTs) {
  console.error(
    `Could not read a thread timestamp from "${target}". Pass a Slack permalink or a 1234567890.123456 ts.`,
  );
  process.exit(1);
}
if (!threadTs) {
  console.error(`No transcript thread with an "Action Items" reply found in the last 30 messages of the channel.`);
  process.exit(1);
}

const replies = await client.conversations.replies({ channel: transcriptsChannel, ts: threadTs, limit: 30 });
const messages = replies.messages || [];
console.log(`\nThread ${threadTs} in ${transcriptsChannel} — ${messages.length} message(s)\n`);

// --- The listener's gates, in order ---

if (!messages.some((m) => isNotesMessage(m.text || ''))) {
  stop('notes/action-items reply', 'no message in this thread mentions "Action Items", so nothing would trigger');
}
pass('notes/action-items reply', 'found — this is what fires the listener');

const header = parseTranscriptHeader(messages[0]?.text || '');
if (!header.title || header.participantEmails.length === 0) {
  stop(
    'header parsed',
    `title="${header.title}", participants=${header.participantEmails.length} — not a Fireflies transcript header`,
  );
}
pass('header parsed', `"${header.title}" · ${header.participantEmails.join(', ')}`);

const ignoredBy = ignoredTitlePattern(header.title, cfg.ignore_title_patterns);
if (ignoredBy) stop('title rule', `matches ignore pattern "${ignoredBy}" — treated as an internal ceremony`);
pass('title rule', 'not an ignored internal ceremony');

const internalDomains = cfg.internal_email_domains?.length ? cfg.internal_email_domains : ['pixelup.in'];
if (!hasExternalParticipant(header, internalDomains)) {
  stop('external participant', `everyone is on ${internalDomains.join(' / ')} — internal meeting`);
}
pass('external participant', 'at least one outside participant — this is a client call');

const match = matchClientForMeeting(conventions, header);
if (!match) {
  stop(
    'client match',
    'no client matched by title name/alias or participant domain — the bot would reply "couldn\'t match this meeting" in-thread',
  );
}
const m = /** @type {NonNullable<typeof match>} */ (match);
pass('client match', `${m.client.display_name} (clients.${m.key})`);

const internalChannel = m.client.internal_channel_id;
if (!looksLikeChannelId(internalChannel) || internalChannel === m.client.channel_id) {
  stop(
    'internal channel',
    `clients.${m.key}.internal_channel_id is "${internalChannel || 'unset'}" — the bot would warn in-thread instead of posting`,
  );
}
pass('internal channel', `would post to ${internalChannel}`);

if (gatesOnly) {
  console.log('\nAll gates pass. Stopping before the model call (--gates-only).');
  process.exit(0);
}

// --- The recap itself ---

const notesText = messages.find((m2) => isNotesMessage(m2.text || ''))?.text || '';
console.log('\nGenerating recap…');
const recap = await summarizeMeeting({
  displayName: m.client.display_name,
  title: header.title,
  headerText: messages[0]?.text || '',
  notesText,
});

if (!recap.trim()) {
  console.error('\nRecap came back empty — the listener would log an error and post nothing.');
  process.exit(1);
}

console.log(`\n${'─'.repeat(60)}\n${recap}\n${'─'.repeat(60)}`);

if (!post) {
  console.log(`\nDry run — not posted. Re-run with --post to send this to ${internalChannel}.`);
  process.exit(0);
}

await client.chat.postMessage({
  channel: /** @type {string} */ (internalChannel),
  text: recap,
  unfurl_links: false,
  unfurl_media: false,
});
console.log(`\nPosted to ${internalChannel}.`);
