import { query } from '@anthropic-ai/claude-agent-sdk';
import { untrusted } from '../agent/tools/read-link.js';
import { compactMessages, fetchChannelHistory, fetchThreadReplies } from '../agent/tools/slack-read.js';
import { loadConventions } from '../config/index.js';
import { classifyChannelName, isPlaceholderId } from '../config/resolver.js';
import { shouldRun, zonedParts } from './client-updates.js';

/**
 * Morning brief for the founder, from INTERNAL channels only.
 *
 * Shape, and why: gathering is plain code (Slack reads, filtering, compaction)
 * and only the final write-up is a model call — one toolless single turn for the
 * whole workspace, not one per channel. A brief that ran the full agent per
 * channel would cost ~20 agent loops every weekday morning to answer a question
 * that needs no tools once the text is in hand.
 *
 * Internal-only is enforced by NAME (`classifyChannelName`), the same signal the
 * client-channel guard uses, so a `{client}-pixelup` channel can never be swept
 * in even if someone lists its ID in config. Delivery is a DM and asserts the
 * `D…` channel Slack hands back — this module has no code path that can post
 * into a channel.
 */

const TICK_MS = 60 * 1000;

/** Pinned per the hard rules in CLAUDE.md (model is set in code, never config). */
const MODEL = 'claude-sonnet-5';

/** Per-channel slice of the digest. One loud channel must not crowd out the rest. */
const PER_CHANNEL_MAX_CHARS = 4000;
/** Whole-digest budget handed to the model. */
const TOTAL_MAX_CHARS = 40000;
/** Backstop on one channel's history read over the thread-scan window. */
const SCAN_MAX_MESSAGES = 600;

/**
 * How far back to look for thread PARENTS. Wider than the brief window because a
 * thread started last week can get its replies yesterday, and Slack keys history
 * off the parent's timestamp — see `fetchWindowReplies`.
 */
const DEFAULT_THREAD_SCAN_HOURS = 7 * 24;
/** Threads expanded per channel, busiest-most-recent first. Bounds the API calls. */
const MAX_THREADS_PER_CHANNEL = 12;
/** Newest replies kept per thread. */
const MAX_REPLIES_PER_THREAD = 30;

/** Schedule defaults, applied when `daily_brief` leaves a field out. */
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const DEFAULT_HOUR = 9;
/** Window the brief covers when config doesn't say. */
const DEFAULT_LOOKBACK_HOURS = 24;

/** Slack subtypes that are channel bookkeeping, not team activity. */
const NOISE_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'pinned_item',
  'unpinned_item',
  'bot_add',
  'bot_remove',
]);

/**
 * @typedef {Object} BriefChannel
 * @property {string} id
 * @property {string} name
 * @property {string | null} clientKey
 * @property {boolean} isMember - Bot is in the channel; false means history will fail.
 * @property {'config-internal' | 'internal-allowlist' | 'discovered-internal'} source
 */

/**
 * Is this message team activity worth briefing on?
 * @param {any} m
 * @returns {boolean}
 */
export function isSubstantiveMessage(m) {
  if (m?.type !== 'message') return false;
  if (m.subtype && NOISE_SUBTYPES.has(m.subtype)) return false;
  return Boolean(m.text || m.files?.length || m.attachments?.length || m.reactions?.length);
}

/**
 * Every channel the bot can see, keyed by ID. Membership rides along so the
 * brief can report what it could not read instead of silently omitting it.
 * @param {import('@slack/web-api').WebClient} client
 * @returns {Promise<Map<string, { id: string, name: string, isPrivate: boolean, isMember: boolean }>>}
 */
export async function listWorkspaceChannels(client) {
  /** @type {Map<string, { id: string, name: string, isPrivate: boolean, isMember: boolean }>} */
  const byId = new Map();
  /** @type {string | undefined} */
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor && { cursor }),
    });
    for (const c of /** @type {any[]} */ (res.channels || [])) {
      if (!c.id) continue;
      byId.set(c.id, {
        id: c.id,
        name: c.name || '',
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
      });
    }
    cursor = /** @type {any} */ (res).response_metadata?.next_cursor || undefined;
  } while (cursor);
  return byId;
}

/**
 * Pick the internal channels to sweep. Pure, so the selection rules are
 * testable without Slack.
 *
 * Two kinds of channel get swept, and nothing else:
 *  - A REGISTERED client's internal channel — from `internal_channel_id`, or
 *    discovered as `{key}-internal` where `key` is a client in conventions.
 *  - A non-client team channel named explicitly in `daily_brief.internal_channels`.
 *
 * The allowlist is deliberately strict: an `{something}-internal` channel whose
 * key is NOT a registered client is skipped rather than guessed at, because the
 * agency has team channels (#design-engineering-internal) that follow the same
 * naming as client ones. The cost is that a new client's channel does not join
 * the brief until they are registered — so those land in `skipped` and get
 * reported, never silently dropped.
 *
 * `excluded` is a CONFIG-MISTAKE report — channels a source pointed at that
 * turned out to be client-facing — not an inventory of the workspace's client
 * channels. A `{client}-pixelup` channel that no source names is simply never
 * considered, and correctly appears nowhere in the result.
 * @param {Map<string, { id: string, name: string, isPrivate: boolean, isMember: boolean }>} workspace
 * @param {import('../config/index.js').Conventions} conventions
 * @returns {{ channels: BriefChannel[], excluded: Array<{ id: string, name: string, reason: string }>, missing: Array<{ id: string, reason: string }>, skipped: Array<{ name: string, reason: string }> }}
 */
export function selectInternalChannels(workspace, conventions) {
  /** @type {Map<string, BriefChannel>} */
  const chosen = new Map();
  /** @type {Array<{ id: string, name: string, reason: string }>} */
  const excluded = [];
  /** @type {Array<{ id: string, reason: string }>} */
  const missing = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  /** Decided IDs — an ID named by two sources must be reported once, not twice. */
  const seen = new Set();

  // Team channels to sweep, by name. Anything not here and not owned by a
  // registered client stays out of the brief.
  const allowlist = new Set(
    (conventions.daily_brief?.internal_channels || []).map((n) => n.trim().toLowerCase().replace(/^#/, '')),
  );

  /**
   * @param {string} id
   * @param {BriefChannel['source']} source
   * @param {string | null} clientKey
   */
  const consider = (id, source, clientKey) => {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = workspace.get(id);
    if (!entry) {
      missing.push({ id, reason: 'not visible to the bot (archived, or never invited to a private channel)' });
      return;
    }
    const { kind, clientKey: fromName } = classifyChannelName(entry.name);
    if (kind === 'client-external') {
      excluded.push({ id, name: entry.name, reason: 'client-facing channel' });
      return;
    }
    chosen.set(id, {
      id,
      name: entry.name,
      clientKey: clientKey || fromName,
      isMember: entry.isMember,
      source,
    });
  };

  for (const [key, c] of Object.entries(conventions.clients)) {
    if (isPlaceholderId(c.internal_channel_id)) continue;
    consider(/** @type {string} */ (c.internal_channel_id), 'config-internal', key);
  }

  for (const entry of workspace.values()) {
    if (seen.has(entry.id)) continue;
    const name = entry.name.toLowerCase();
    const { kind, clientKey } = classifyChannelName(entry.name);

    // An explicitly allowlisted team channel, whatever its name looks like.
    if (allowlist.has(name)) {
      consider(entry.id, 'internal-allowlist', null);
      continue;
    }
    if (kind !== 'client-internal') continue;

    // `{key}-internal` — sweep it only when `key` is a client we know about.
    if (clientKey && conventions.clients[clientKey]) {
      consider(entry.id, 'discovered-internal', clientKey);
    } else {
      skipped.push({
        name: entry.name,
        reason: 'not a registered client and not in daily_brief.internal_channels',
      });
    }
  }

  const channels = [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { channels, excluded, missing, skipped: skipped.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Start of the brief window as an ISO timestamp. `fetchChannelHistory` parses
 * it with `Date.parse`, so hour granularity works — a date alone would drag in
 * or cut off part of a day depending on the timezone.
 * @param {Date} now
 * @param {number} hours
 * @returns {string}
 */
export function windowStart(now, hours) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * How far back to look. Monday gets a longer window so Friday-evening and
 * weekend activity isn't briefed to nobody.
 * @param {string} weekday - Lowercase weekday name.
 * @param {{ lookback_hours?: number, monday_lookback_hours?: number }} cfg
 * @returns {number}
 */
export function lookbackHoursFor(weekday, cfg) {
  if (weekday === 'monday' && cfg.monday_lookback_hours) return cfg.monday_lookback_hours;
  return cfg.lookback_hours || DEFAULT_LOOKBACK_HOURS;
}

/**
 * YYYY-MM-DD or ISO timestamp → Slack's epoch-seconds, as a number for comparison.
 * @param {string} value
 * @returns {number}
 */
function toEpochSeconds(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/**
 * Mark a thread reply so the digest can't be misread as a top-level message,
 * and carry just enough of the parent for the reply to make sense.
 * @param {any} reply
 * @param {any} parent
 * @returns {any}
 */
function annotateReply(reply, parent) {
  const full = (parent.text || '').replace(/\s+/g, ' ');
  const excerpt = full.length > 80 ? `${full.slice(0, 80)}…` : full || '(no text)';
  return { ...reply, text: `↳ [reply in thread on "${excerpt}"] ${reply.text || ''}` };
}

/**
 * Threads this channel saw activity on, returned RAW (untruncated, un-annotated)
 * so mention detection reads the author's real words.
 *
 * Two cases, both real and both previously invisible:
 *  - A question asked in the window and ANSWERED in its thread. Without this the
 *    brief reports it as unanswered and tells the reader they're blocking work
 *    that is already moving — the worst kind of wrong.
 *  - A thread whose parent is OLDER than the window but which got replies inside
 *    it (QA rounds run for days). `conversations.history` keys off the parent's
 *    own ts, so that thread does not appear at all. Detected here via the
 *    parent's `latest_reply`, which is why the scan window is wider than the
 *    brief window.
 * @param {{ client: import('@slack/web-api').WebClient, channelId: string, parents: any[], sinceTs: number, untilTs: number }} args
 * @returns {Promise<{ threads: Array<{ parent: any, replies: any[] }>, threadsExpanded: number, threadsSkipped: number }>}
 */
async function fetchWindowReplies({ client, channelId, parents, sinceTs, untilTs }) {
  const candidates = parents
    .filter((m) => (m.reply_count || 0) > 0 && Number(m.latest_reply || 0) >= sinceTs)
    .sort((a, b) => Number(b.latest_reply || 0) - Number(a.latest_reply || 0));

  const expand = candidates.slice(0, MAX_THREADS_PER_CHANNEL);
  /** @type {Array<{ parent: any, replies: any[] }>} */
  const threads = [];
  let threadsExpanded = 0;

  for (const parent of expand) {
    const all = await fetchThreadReplies(client, channelId, parent.thread_ts || parent.ts);
    const inWindow = all
      // replies[0] is the parent itself; drop it — it is handled as a top-level
      // message when it belongs to the window, and as context when it doesn't.
      .filter((r) => r.ts !== parent.ts)
      .filter((r) => {
        const ts = Number(r.ts);
        return ts >= sinceTs && ts <= untilTs;
      })
      .filter(isSubstantiveMessage);
    if (inWindow.length) threadsExpanded++;
    threads.push({ parent, replies: inWindow });
  }

  return { threads, threadsExpanded, threadsSkipped: candidates.length - expand.length };
}

/**
 * Messages in this channel that tag the brief's recipient, and whether the
 * recipient has already answered in that thread.
 *
 * This is the whole basis of the "Needs you" section, and it lives in code on
 * purpose. Left to the model, that section drifted run to run on identical data
 * — because the prompt never said WHICH person "you" was, so the model inferred
 * it from whichever ID appeared most. An `<@U…>` match against the recipient's
 * real ID cannot drift.
 *
 * `answered` is what keeps a resolved ask from being re-raised: if the recipient
 * posted in the same thread after being tagged, the ball is no longer with them.
 * @param {{ recipientId: string, channelName: string, topLevel: any[], threads: Array<{ parent: any, replies: any[] }> }} args
 * @returns {Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>}
 */
export function findDirectMentions({ recipientId, channelName, topLevel, threads }) {
  if (!recipientId) return [];
  const tag = `<@${recipientId}>`;

  // thread_ts → every in-window message in that thread, for the "did they reply" check.
  /** @type {Map<string, any[]>} */
  const byThread = new Map();
  for (const t of threads) {
    byThread.set(t.parent.thread_ts || t.parent.ts, [t.parent, ...t.replies]);
  }

  const everyMessage = [...topLevel, ...threads.flatMap((t) => t.replies)];
  /** @type {Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>} */
  const found = [];
  const seenTs = new Set();

  for (const m of everyMessage) {
    if (seenTs.has(m.ts)) continue;
    if (!(m.text || '').includes(tag)) continue;
    // A message the recipient wrote themselves is not someone waiting on them.
    if (m.user === recipientId) continue;
    seenTs.add(m.ts);

    const threadKey = m.thread_ts || m.ts;
    const siblings = byThread.get(threadKey) || [];
    const answered = siblings.some((r) => r.user === recipientId && Number(r.ts) > Number(m.ts));

    found.push({
      channel: channelName,
      author: m.user ? `<@${m.user}>` : m.username || 'bot',
      ts: m.ts,
      text: (m.text || '').replace(/\s+/g, ' ').slice(0, 300),
      answered,
    });
  }
  return found.sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * Read each channel's window, threads included. Zero model calls — this is the
 * cheap part, and quiet channels drop out here so they never reach the prompt.
 *
 * The history read spans `scanHours` (wider than the brief window) so threads
 * with old parents and fresh replies are found; only messages and replies whose
 * own timestamp falls inside the brief window are ever briefed on.
 * @param {{ client: import('@slack/web-api').WebClient, channels: BriefChannel[], since: string, until?: string, scanHours?: number, recipientId?: string }} args
 * @returns {Promise<{ active: Array<BriefChannel & { messageCount: number, text: string, threadsExpanded: number }>, quiet: BriefChannel[], unreadable: Array<BriefChannel & { error: string }>, mentions: Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }> }>}
 */
export async function gatherChannelActivity({ client, channels, since, until, scanHours, recipientId }) {
  /** @type {Array<BriefChannel & { messageCount: number, text: string, threadsExpanded: number }>} */
  const active = [];
  /** @type {BriefChannel[]} */
  const quiet = [];
  /** @type {Array<BriefChannel & { error: string }>} */
  const unreadable = [];
  /** @type {Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>} */
  const mentions = [];

  const sinceTs = toEpochSeconds(since);
  const untilTs = until ? toEpochSeconds(until) : Number.MAX_SAFE_INTEGER;
  const scanSince = new Date((sinceTs - (scanHours ?? DEFAULT_THREAD_SCAN_HOURS) * 3600) * 1000).toISOString();

  for (const ch of channels) {
    if (!ch.isMember) {
      unreadable.push({ ...ch, error: 'not_in_channel (invite the bot)' });
      continue;
    }
    try {
      // One read over the wider scan window: it yields the in-window top-level
      // messages AND the older parents whose threads may have moved yesterday.
      const { messages } = await fetchChannelHistory(client, ch.id, {
        limit: SCAN_MAX_MESSAGES,
        sinceDate: scanSince,
        untilDate: until,
      });

      const topLevel = messages.filter((m) => Number(m.ts) >= sinceTs).filter(isSubstantiveMessage);
      const { threads, threadsExpanded, threadsSkipped } = await fetchWindowReplies({
        client,
        channelId: ch.id,
        parents: messages,
        sinceTs,
        untilTs,
      });

      // Mentions come off the RAW messages, before annotation or truncation.
      if (recipientId) {
        mentions.push(...findDirectMentions({ recipientId, channelName: ch.name, topLevel, threads }));
      }

      const annotatedReplies = threads.flatMap((t) =>
        t.replies.slice(-MAX_REPLIES_PER_THREAD).map((r) => annotateReply(r, t.parent)),
      );
      const substantive = [...topLevel, ...annotatedReplies];
      if (!substantive.length) {
        quiet.push(ch);
        continue;
      }

      const note = threadsSkipped
        ? `\n[${threadsSkipped} more thread(s) in this channel had replies in the window but were not expanded.]`
        : '';
      active.push({
        ...ch,
        messageCount: substantive.length,
        threadsExpanded,
        text: compactMessages(substantive, { maxChars: PER_CHANNEL_MAX_CHARS }) + note,
      });
    } catch (e) {
      const code = /** @type {any} */ (e)?.data?.error;
      unreadable.push({ ...ch, error: code || String(e) });
    }
  }
  return { active, quiet, unreadable, mentions };
}

/**
 * Assemble the prompt digest, newest-activity channels first and trimmed to the
 * total budget. What gets dropped is stated in the digest rather than vanishing.
 * @param {{ active: Array<BriefChannel & { messageCount: number, text: string }>, quiet?: BriefChannel[], mentions?: Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>, recipientName?: string, conventions: import('../config/index.js').Conventions, since: string, until: string }} args
 * @returns {{ text: string, includedChannels: string[], droppedChannels: string[], openMentions: number }}
 */
export function buildDigest({
  active,
  quiet = [],
  mentions = [],
  recipientName = 'the reader',
  conventions,
  since,
  until,
}) {
  const byVolume = [...active].sort((a, b) => b.messageCount - a.messageCount);
  /** @type {string[]} */
  const sections = [];
  /** @type {string[]} */
  const includedChannels = [];
  /** @type {string[]} */
  const droppedChannels = [];
  let size = 0;

  for (const ch of byVolume) {
    // Only call it a client if it IS one. Plenty of internal channels match the
    // `{key}-internal` convention without a client behind them (#pixelup-internal,
    // #design-engineering-internal) — labelling those "client: pixelup" would put
    // a team channel in the per-client section of the brief.
    const clientName = ch.clientKey ? conventions.clients[ch.clientKey]?.display_name : undefined;
    const label = clientName ? `#${ch.name} (client: ${clientName})` : `#${ch.name}`;
    const section = `=== ${label} — ${ch.messageCount} message(s) ===\n${ch.text}`;
    if (size + section.length > TOTAL_MAX_CHARS && includedChannels.length > 0) {
      droppedChannels.push(`#${ch.name}`);
      continue;
    }
    size += section.length + 2;
    sections.push(section);
    includedChannels.push(`#${ch.name}`);
  }

  // Silent projects are a fact the founder wants ("nothing moved on Sully"), so
  // name them. They carry no messages, hence a list rather than a section.
  const quietLabels = quiet
    .map((ch) => (ch.clientKey ? conventions.clients[ch.clientKey]?.display_name : undefined) || `#${ch.name}`)
    .sort((a, b) => a.localeCompare(b));

  const header =
    `Window: ${since} → ${until}\n` +
    `Internal channels with activity: ${includedChannels.length}\n` +
    (quietLabels.length
      ? `Projects with NO activity in the window (name these in the "no update" line): ${quietLabels.join(', ')}\n`
      : '') +
    (droppedChannels.length
      ? `NOTE: ${droppedChannels.length} channel(s) omitted from this digest for size — ${droppedChannels.join(', ')}. Say so at the end of the brief.\n`
      : '');

  // The "Needs you" candidate list, decided in code by @-mention. Answered ones
  // are named but marked, so the model knows not to raise them again.
  const open = mentions.filter((m) => !m.answered);
  const answered = mentions.filter((m) => m.answered);
  const mentionBlock =
    `=== TAGGED ${recipientName.toUpperCase()} DIRECTLY — the ONLY permitted source for part 2 ===\n` +
    (open.length
      ? open
          .map((m) => `[#${m.channel}] ${m.author}: "${m.text}" — ${recipientName} has NOT replied in this thread.`)
          .join('\n')
      : `Nothing in the window tagged ${recipientName} and went unanswered.`) +
    (answered.length
      ? `\n\nAlready handled — ${recipientName} replied in-thread, DO NOT put these in part 2:\n` +
        answered.map((m) => `[#${m.channel}] ${m.author}: "${m.text}"`).join('\n')
      : '');

  return {
    text: `${header}\n${mentionBlock}\n\n${sections.join('\n\n')}`,
    includedChannels,
    droppedChannels,
    openMentions: open.length,
  };
}

/**
 * @param {string} voice
 * @param {{ name: string, id: string }} recipient
 * @returns {string}
 */
function buildSystemPrompt(voice, recipient) {
  return `You are Pixelup Bot writing the morning brief for ${recipient.name} at Pixelup Labs, a design agency. \
Your input is a digest of yesterday's messages from the agency's INTERNAL Slack channels (team only — no clients \
are in these channels). This brief is delivered as a private DM to ${recipient.name}.

THE READER IS ${recipient.name}, whose Slack ID is ${recipient.id} — they appear in the digest as <@${recipient.id}>. \
"You" always means ${recipient.name} and nobody else. Any other <@U…> is a colleague, never the reader.

Your job is to tell them what they need to know before their day starts, and nothing else. They will read this \
in under a minute. Assume they have not read Slack.

Write only what the digest supports. Never guess at a cause, an owner, or a status that isn't there. Say "no \
update" for a project rather than inventing progress, and never pad — a short brief is a good brief.

Agency voice: ${voice}

Output Slack mrkdwn only (*bold*, "• " bullets, <#C123> is fine to echo back if present — no "#" headings, \
no tables, no links you were not given).

The brief has exactly TWO parts, in this order. Both headers always appear.

*:one: Where every project stands*

This is the main event — the founder's picture of the whole agency. One bullet per active project, busiest first:

• *{Client}* — what happened yesterday, then where it stands now. Fold the blockers and the unanswered \
questions into this same bullet, naming who each one is waiting on. Two sentences at most.

Then, if any internal (non-client) channels saw activity, one final bullet "• *Internal* — …" covering them \
together. And if some projects were silent, close the part with one line: "_No update: X, Y, Z._"

*:two: Needs you*

Draw this part ONLY from the digest's "TAGGED ... DIRECTLY" block. That block is computed in code from real \
@-mentions, so it is the complete and authoritative list of what is waiting on ${recipient.name} — do not add \
items from anywhere else in the digest, however important they look, and do not drop any item that is in it.

One bullet per unanswered item, leading with the ask, naming who is waiting. Items marked "already handled" are \
resolved: leave them out. If the block says nothing went unanswered, write exactly "• Nothing blocking you." \
and stop.

An approval question that tags nobody ("is this good enough to send?") does NOT belong here — it goes in part 1 \
as project status, because nothing shows it is ${recipient.name}'s to answer.

Attribute people by their Slack mention exactly as it appears (<@U123>) — do not invent names. Put the channel \
in parens where it helps them go look. Keep the whole brief under 450 words. No preamble, no sign-off, at most \
one emoji beyond the two part markers.`;
}

/**
 * Write the brief. Reads nothing, posts nothing, has no tools.
 * @param {string} digest
 * @param {{ conventions?: import('../config/index.js').Conventions, recipient?: { name: string, id: string }, query?: typeof query }} [options]
 * @returns {Promise<string>}
 */
export async function summarizeBrief(digest, options = {}) {
  const conventions = options.conventions || loadConventions();
  const queryFn = options.query || query;
  const recipient = options.recipient || { name: 'the reader', id: 'unknown' };

  const prompt =
    `${untrusted(digest, 'Slack digest')}\n\n` +
    'Write the founder brief now, following the structure in your instructions.';

  /** @type {string[]} */
  const parts = [];
  for await (const message of queryFn({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: buildSystemPrompt(conventions.agency.voice, recipient),
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
    },
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * DM the brief. Asserts Slack handed back a `D…` conversation, so there is no
 * path from here into a channel of any kind.
 * @param {{ client: import('@slack/web-api').WebClient, recipientId: string, text: string }} args
 * @returns {Promise<string>} The DM channel ID posted to.
 */
export async function deliverBrief({ client, recipientId, text }) {
  const opened = await client.conversations.open({ users: recipientId });
  const channel = /** @type {any} */ (opened)?.channel?.id;
  if (!channel) throw new Error(`Could not open a DM with ${recipientId}.`);
  if (!/^D/.test(channel)) {
    throw new Error(`Refusing to send the brief: ${channel} is not a DM conversation.`);
  }
  await client.chat.postMessage({ channel, text, mrkdwn: true });
  return channel;
}

/**
 * Gather → summarize → DM. Returns what it did so the CLI can print it and the
 * scheduler can log it.
 * `recipientId` is who the brief is ABOUT — it anchors "Needs you". `deliverTo`
 * is who this copy is SENT to, and defaults to the same person. They differ only
 * when someone previews another person's brief: the section must stay anchored on
 * the real subject, or a test copy silently reports the previewer's asks instead.
 * @param {{ client: import('@slack/web-api').WebClient, logger?: { info: Function, error: Function }, conventions?: import('../config/index.js').Conventions, recipientId?: string, deliverTo?: string, since?: string, until?: string, deliver?: boolean, query?: typeof query }} args
 * @returns {Promise<{ brief: string, digest: string, active: Array<{ name: string, messageCount: number, threadsExpanded: number }>, quiet: string[], unreadable: Array<{ name: string, error: string }>, excluded: Array<{ name: string, reason: string }>, skipped: Array<{ name: string, reason: string }>, mentions: Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>, recipientName: string, missing: Array<{ id: string, reason: string }>, deliveredTo: string | null, since: string, until: string }>}
 */
export async function runDailyBrief({
  client,
  logger,
  conventions: given,
  recipientId,
  deliverTo,
  since,
  until,
  deliver = true,
  query: queryFn,
}) {
  const conventions = given || loadConventions();
  const cfg = conventions.daily_brief || {};
  const sendTo = deliverTo || recipientId;
  const timezone = cfg.timezone || DEFAULT_TIMEZONE;
  const now = new Date();
  const parts = zonedParts(now, timezone);
  const windowSince = since || windowStart(now, lookbackHoursFor(parts.weekday, cfg));
  const windowUntil = until || now.toISOString();

  const workspace = await listWorkspaceChannels(client);
  const { channels, excluded, missing, skipped } = selectInternalChannels(workspace, conventions);
  // Who the brief is FOR. "Needs you" is anchored on this ID, so an unknown
  // recipient must not silently become a guess — the section stays empty instead.
  const recipient = {
    id: recipientId || '',
    name: (recipientId && conventions.users?.[recipientId]?.name) || 'the reader',
  };

  const { active, quiet, unreadable, mentions } = await gatherChannelActivity({
    client,
    channels,
    since: windowSince,
    until: windowUntil,
    scanHours: cfg.thread_scan_hours,
    recipientId: recipient.id,
  });

  const summary = {
    active: active.map((c) => ({
      name: `#${c.name}`,
      messageCount: c.messageCount,
      threadsExpanded: c.threadsExpanded,
    })),
    quiet: quiet.map((c) => `#${c.name}`),
    unreadable: unreadable.map((c) => ({ name: `#${c.name}`, error: c.error })),
    excluded: excluded.map((c) => ({ name: `#${c.name}`, reason: c.reason })),
    skipped: skipped.map((c) => ({ name: `#${c.name}`, reason: c.reason })),
    mentions,
    recipientName: recipient.name,
    missing,
    since: windowSince,
    until: windowUntil,
  };

  if (!active.length) {
    const brief = '*Morning brief* — no internal channel activity in the window. Nothing to report. :sunny:';
    let deliveredTo = null;
    if (deliver && sendTo) deliveredTo = await deliverBrief({ client, recipientId: sendTo, text: brief });
    logger?.info('Daily brief: no activity in window.');
    return { ...summary, digest: '', brief, deliveredTo };
  }

  const { text: digest, droppedChannels } = buildDigest({
    active,
    quiet,
    mentions,
    recipientName: recipient.name,
    conventions,
    since: windowSince,
    until: windowUntil,
  });
  const brief = await summarizeBrief(digest, { conventions, recipient, query: queryFn });

  /** @type {string[]} */
  const footnotes = [];
  if (unreadable.length) {
    footnotes.push(
      `_Couldn't read ${unreadable.length} channel(s): ${unreadable.map((c) => `#${c.name}`).join(', ')} — invite me to include them._`,
    );
  }
  if (droppedChannels.length) {
    footnotes.push(`_Trimmed for size: ${droppedChannels.join(', ')}._`);
  }
  const text = footnotes.length ? `${brief}\n\n${footnotes.join('\n')}` : brief;

  let deliveredTo = null;
  if (deliver && sendTo) deliveredTo = await deliverBrief({ client, recipientId: sendTo, text });
  logger?.info(`Daily brief: ${active.length} active channel(s), delivered=${Boolean(deliveredTo)}.`);

  return { ...summary, digest, brief: text, deliveredTo };
}

/**
 * Start the scheduler. Returns null when disabled — the app runs fine without
 * it, and it ships disabled so nothing fires before a human has seen one brief.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ info: Function, error: Function }} logger
 * @returns {NodeJS.Timeout | null}
 */
export function startDailyBriefScheduler(client, logger) {
  const conventions = loadConventions();
  const cfg = conventions.daily_brief;
  if (!cfg?.enabled) {
    logger.info('Daily brief scheduler disabled (daily_brief.enabled is false).');
    return null;
  }
  if (!cfg.recipient_slack_id) {
    logger.error('Daily brief scheduler not started: daily_brief.recipient_slack_id is not set.');
    return null;
  }

  const recipientId = cfg.recipient_slack_id;
  const timezone = cfg.timezone || DEFAULT_TIMEZONE;
  const schedule = {
    enabled: true,
    days: cfg.days || [...DEFAULT_DAYS],
    hour: cfg.hour ?? DEFAULT_HOUR,
    minute: cfg.minute ?? 0,
  };
  /** @type {string | null} */
  let lastRunKey = null;

  const handle = setInterval(() => {
    try {
      const parts = zonedParts(new Date(), timezone);
      if (shouldRun(parts, schedule, lastRunKey)) {
        lastRunKey = parts.dateKey;
        void runDailyBrief({ client, logger, recipientId }).catch((e) => logger.error(`Daily brief run failed: ${e}`));
      }
    } catch (e) {
      logger.error(`Daily brief scheduler tick failed: ${e}`);
    }
  }, TICK_MS);
  handle.unref?.();
  logger.info(
    `Daily brief scheduler started (${schedule.days.join('/')} ${schedule.hour}:${String(schedule.minute).padStart(2, '0')} ${timezone} → DM ${recipientId}).`,
  );
  return handle;
}
