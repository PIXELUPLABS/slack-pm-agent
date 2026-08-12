import { query } from '@anthropic-ai/claude-agent-sdk';
import { untrusted } from '../agent/tools/read-link.js';
import { compactMessages, fetchChannelHistory, fetchThreadReplies } from '../agent/tools/slack-read.js';
import { loadConventions } from '../config/index.js';
import { classifyChannelName, isPlaceholderId } from '../config/resolver.js';
import { shouldRun, zonedParts } from './client-updates.js';

/**
 * Morning brief for the founder, from INTERNAL channels only. Runs in one of two
 * modes, chosen by the weekday: a `daily` brief Tue–Fri, and a `weekly` review on
 * the `weekly_review.day` (Monday).
 *
 * Shape, and why. Gathering is plain code in both modes — Slack reads, filtering,
 * thread expansion, compaction — and the model only ever writes prose.
 *
 *  - `daily`: one toolless turn for the whole workspace. Messages stay
 *    chronological and, when a busy channel hits its cap, preserve both the
 *    opening context and latest state. The model groups them into workstreams,
 *    reconstructs each arc, removes chatter, and writes the supported current
 *    state. Channel volume never stands in for importance.
 *  - `weekly`: map-reduce. One toolless turn PER CHANNEL summarizes that
 *    channel's week (`summarizeChannels`), then one more turn writes the review
 *    from those summaries. Seven days of input compresses ~35:1 instead of ~5:1,
 *    which makes the model's job selection rather than transcription — and
 *    selection needs every project described at comparable depth. A single
 *    week-wide digest cannot give it that: every channel needs comparable depth
 *    across seven days, beyond what a bounded workspace-wide prompt can retain.
 *
 * The per-channel turns are NOT the thing the original note warned off. That was
 * ~20 *agent loops* (tool-using, multi-turn) every weekday; these are toolless
 * single turns, once a week, on the run that fires least often.
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

/**
 * Per-mode budgets. Held as data rather than branches so the difference between a
 * daily brief and a weekly review is one table you can read in full.
 *
 * `weekly.perChannelMaxChars` is large because each channel gets its OWN model
 * call — the text no longer competes with 20 other channels for one prompt, so
 * most channels never truncate at all.
 *
 * `threadScanHours` must exceed `lookbackHours` in both modes: `conversations.history`
 * keys off a thread parent's timestamp, so a parent older than the window whose
 * replies landed inside it is otherwise invisible. See `fetchWindowReplies`.
 */
const MODES = {
  daily: {
    // Daily interpretation needs enough of both the request and its resolution
    // to reconstruct the conversation arc rather than echoing the last replies.
    perChannelMaxChars: 6000,
    totalMaxChars: 60000,
    maxThreadsPerChannel: 12,
    maxRepliesPerThread: 30,
    scanMaxMessages: 600,
    lookbackHours: 24,
    threadScanHours: 7 * 24,
  },
  weekly: {
    perChannelMaxChars: 24000,
    totalMaxChars: 60000,
    // Raised with the window: over a week the thread cap bounds part 2's
    // completeness too, since a mention is only seen in an expanded thread.
    maxThreadsPerChannel: 35,
    maxRepliesPerThread: 30,
    scanMaxMessages: 2000,
    lookbackHours: 7 * 24,
    threadScanHours: 14 * 24,
  },
};

/** Per-channel summaries in flight at once during the weekly map stage. */
const SUMMARY_CONCURRENCY = 4;
/** Ceiling on one channel's summary, so 20 of them still reduce cleanly. */
const CHANNEL_SUMMARY_MAX_CHARS = 2000;

/** @typedef {'daily' | 'weekly'} BriefMode */

/** Schedule defaults, applied when `daily_brief` leaves a field out. */
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const DEFAULT_HOUR = 9;
/** Window the brief covers when config doesn't say. */
const DEFAULT_LOOKBACK_HOURS = MODES.daily.lookbackHours;
const DEFAULT_WEEKLY_DAY = 'monday';

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
 * Which kind of brief this weekday gets.
 *
 * Weekly mode is opt-in (`weekly_review.enabled`), matching how `daily_brief.enabled`
 * works, so flipping one boolean puts Monday back on the daily path — including its
 * `monday_lookback_hours` weekend window, which stays as the fallback for exactly
 * that reason rather than becoming dead config.
 * @param {string} weekday - Lowercase weekday name.
 * @param {{ weekly_review?: { enabled?: boolean, day?: string } }} [cfg]
 * @returns {BriefMode}
 */
export function resolveMode(weekday, cfg = {}) {
  const weekly = cfg.weekly_review;
  if (!weekly?.enabled) return 'daily';
  return weekday === (weekly.day || DEFAULT_WEEKLY_DAY).toLowerCase() ? 'weekly' : 'daily';
}

/**
 * Mode plus the window it covers — the one place window sizing is decided, so the
 * scheduler, the CLI and `runDailyBrief` cannot disagree about it.
 *
 * The weekly window is a trailing 168h rather than a calendar week: it is
 * contiguous with the previous weekly review and leaves no gap after Friday's
 * daily brief (which stopped at Friday's run time), and it needs no boundary math.
 * @param {string} weekday - Lowercase weekday name.
 * @param {any} [cfg] - The `daily_brief` config block.
 * @param {BriefMode} [modeOverride] - Force a mode (the CLI previewing the other one).
 * @returns {{ mode: BriefMode, lookbackHours: number, scanHours: number }}
 */
export function windowHoursFor(weekday, cfg = {}, modeOverride = undefined) {
  const mode = modeOverride || resolveMode(weekday, cfg);
  if (mode === 'weekly') {
    const wr = cfg.weekly_review || {};
    return {
      mode,
      lookbackHours: wr.lookback_hours || MODES.weekly.lookbackHours,
      scanHours: wr.thread_scan_hours || MODES.weekly.threadScanHours,
    };
  }
  return {
    mode,
    lookbackHours: lookbackHoursFor(weekday, cfg),
    scanHours: cfg.thread_scan_hours ?? MODES.daily.threadScanHours,
  };
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
 * Compact a week's messages under day headings.
 *
 * "What happened last week" needs a timeline, and flat `[ts:…]` lines make the
 * model reconstruct one from epoch seconds. Bucketing by local day is free and
 * deterministic, so the arc becomes something it reads rather than infers — the
 * same instinct as computing part 2 in code.
 *
 * Days are filled newest-first against a shared budget, so an over-budget channel
 * loses whole early days (and says so) instead of losing them silently mid-line.
 * @param {any[]} messages
 * @param {{ maxChars: number, timezone: string }} options
 * @returns {string}
 */
export function compactByDay(messages, { maxChars, timezone }) {
  /** @type {Map<string, { dateKey: string, weekday: string, messages: any[] }>} */
  const byDay = new Map();
  for (const m of messages) {
    const at = new Date(Number(m.ts) * 1000);
    if (Number.isNaN(at.getTime())) continue;
    const { dateKey, weekday } = zonedParts(at, timezone);
    const bucket = byDay.get(dateKey) || { dateKey, weekday, messages: [] };
    bucket.messages.push(m);
    byDay.set(dateKey, bucket);
  }

  const days = [...byDay.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  /** @type {string[]} */
  const kept = [];
  let remaining = maxChars;
  let droppedDays = 0;

  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    const heading = `— ${day.weekday[0].toUpperCase()}${day.weekday.slice(1)} ${day.dateKey} —`;
    // Not enough left for a heading plus something worth reading under it.
    if (kept.length && remaining < heading.length + 200) {
      droppedDays = i + 1;
      break;
    }
    const body = compactMessages(day.messages, { maxChars: Math.max(remaining - heading.length - 2, 200) });
    kept.unshift(`${heading}\n${body}`);
    remaining -= heading.length + body.length + 2;
  }

  const note = droppedDays ? `[${droppedDays} earlier day(s) of this window omitted for size.]\n` : '';
  return note + kept.join('\n\n');
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
 * @param {{ client: import('@slack/web-api').WebClient, channelId: string, parents: any[], sinceTs: number, untilTs: number, maxThreads?: number }} args
 * @returns {Promise<{ threads: Array<{ parent: any, replies: any[] }>, threadsExpanded: number, threadsSkipped: number }>}
 */
async function fetchWindowReplies({ client, channelId, parents, sinceTs, untilTs, maxThreads }) {
  const candidates = parents
    .filter((m) => (m.reply_count || 0) > 0 && Number(m.latest_reply || 0) >= sinceTs)
    .sort((a, b) => Number(b.latest_reply || 0) - Number(a.latest_reply || 0));

  const expand = candidates.slice(0, maxThreads ?? MODES.daily.maxThreadsPerChannel);
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
 * @param {{ client: import('@slack/web-api').WebClient, channels: BriefChannel[], since: string, until?: string, scanHours?: number, recipientId?: string, mode?: BriefMode, timezone?: string }} args
 * @returns {Promise<{ active: Array<BriefChannel & { messageCount: number, text: string, threadsExpanded: number, activeDays: number }>, quiet: BriefChannel[], unreadable: Array<BriefChannel & { error: string }>, mentions: Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }> }>}
 */
export async function gatherChannelActivity({
  client,
  channels,
  since,
  until,
  scanHours,
  recipientId,
  mode = 'daily',
  timezone = DEFAULT_TIMEZONE,
}) {
  const budget = MODES[mode] || MODES.daily;
  /** @type {Array<BriefChannel & { messageCount: number, text: string, threadsExpanded: number, activeDays: number }>} */
  const active = [];
  /** @type {BriefChannel[]} */
  const quiet = [];
  /** @type {Array<BriefChannel & { error: string }>} */
  const unreadable = [];
  /** @type {Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>} */
  const mentions = [];

  const sinceTs = toEpochSeconds(since);
  const untilTs = until ? toEpochSeconds(until) : Number.MAX_SAFE_INTEGER;
  const scanSince = new Date((sinceTs - (scanHours ?? budget.threadScanHours) * 3600) * 1000).toISOString();

  for (const ch of channels) {
    if (!ch.isMember) {
      unreadable.push({ ...ch, error: 'not_in_channel (invite the bot)' });
      continue;
    }
    try {
      // One read over the wider scan window: it yields the in-window top-level
      // messages AND the older parents whose threads may have moved yesterday.
      const { messages } = await fetchChannelHistory(client, ch.id, {
        limit: budget.scanMaxMessages,
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
        maxThreads: budget.maxThreadsPerChannel,
      });

      // Mentions come off the RAW messages, before annotation or truncation.
      if (recipientId) {
        mentions.push(...findDirectMentions({ recipientId, channelName: ch.name, topLevel, threads }));
      }

      const annotatedReplies = threads.flatMap((t) =>
        t.replies.slice(-budget.maxRepliesPerThread).map((r) => annotateReply(r, t.parent)),
      );
      const substantive = [...topLevel, ...annotatedReplies];
      if (!substantive.length) {
        quiet.push(ch);
        continue;
      }

      const note = threadsSkipped
        ? `\n[${threadsSkipped} more thread(s) in this channel had replies in the window but were not expanded.]`
        : '';
      // Over a week the timeline is the point, so weekly text carries day headings.
      const text =
        mode === 'weekly'
          ? compactByDay(substantive, { maxChars: budget.perChannelMaxChars, timezone })
          : compactMessages(substantive, { maxChars: budget.perChannelMaxChars, truncation: 'arc' });
      const activeDays = new Set(substantive.map((m) => zonedParts(new Date(Number(m.ts) * 1000), timezone).dateKey))
        .size;
      active.push({
        ...ch,
        messageCount: substantive.length,
        threadsExpanded,
        activeDays,
        text: text + note,
      });
    } catch (e) {
      const code = /** @type {any} */ (e)?.data?.error;
      unreadable.push({ ...ch, error: code || String(e) });
    }
  }
  return { active, quiet, unreadable, mentions };
}

/**
 * The "Needs you" candidate list, decided in code from real Slack mentions. Answered
 * ones are named but marked, so the model knows not to raise them again.
 *
 * DAILY ONLY. Over 24 hours "tagged and hasn't replied" is a live signal; over a
 * week it degrades into stale asks ("joining the call?" from last Monday), so the
 * weekly review deliberately has no "Needs you" and never builds this block.
 * @param {Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>} mentions
 * @param {string} recipientName
 * @returns {{ text: string, openMentions: number }}
 */
function buildMentionBlock(mentions, recipientName) {
  const open = mentions.filter((m) => !m.answered);
  const answered = mentions.filter((m) => m.answered);
  const text =
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
  return { text, openMentions: open.length };
}

/**
 * Assemble the prompt digest with neutral channel ordering and trim it to the
 * total budget. Message volume is not importance: a quiet approval or blocker can
 * matter more than a busy delivery thread. What gets dropped is stated rather
 * than vanishing.
 * @param {{ active: Array<BriefChannel & { messageCount: number, text: string }>, quiet?: BriefChannel[], mentions?: Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>, recipientName?: string, conventions: import('../config/index.js').Conventions, since: string, until: string, totalMaxChars?: number }} args
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
  totalMaxChars = MODES.daily.totalMaxChars,
}) {
  const ordered = [...active].sort((a, b) => {
    const aIsClient = Boolean(a.clientKey && conventions.clients[a.clientKey]?.display_name);
    const bIsClient = Boolean(b.clientKey && conventions.clients[b.clientKey]?.display_name);
    if (aIsClient !== bIsClient) return aIsClient ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  /** @type {string[]} */
  const sections = [];
  /** @type {string[]} */
  const includedChannels = [];
  /** @type {string[]} */
  const droppedChannels = [];
  let size = 0;

  for (const ch of ordered) {
    // Only call it a client if it IS one. Plenty of internal channels match the
    // `{key}-internal` convention without a client behind them (#pixelup-internal,
    // #design-engineering-internal) — labelling those "client: pixelup" would put
    // a team channel in the per-client section of the brief.
    const clientName = ch.clientKey ? conventions.clients[ch.clientKey]?.display_name : undefined;
    const label = clientName ? `#${ch.name} (client: ${clientName})` : `#${ch.name}`;
    const section = `=== ${label} — ${ch.messageCount} message(s) ===\n${ch.text}`;
    if (size + section.length > totalMaxChars && includedChannels.length > 0) {
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
    'The channel sections are raw chronological evidence. Their order and message counts do NOT indicate ' +
    'importance. Reconstruct each workstream from its opening context through its latest supported state.\n' +
    (quietLabels.length
      ? `Projects with NO activity in the window (name these in the "no update" line): ${quietLabels.join(', ')}\n`
      : '') +
    (droppedChannels.length
      ? `NOTE: ${droppedChannels.length} channel(s) omitted from this digest for size — ${droppedChannels.join(', ')}. Say so at the end of the brief.\n`
      : '');

  const { text: mentionBlock, openMentions } = buildMentionBlock(mentions, recipientName);

  return {
    text: `${header}\n${mentionBlock}\n\n${sections.join('\n\n')}`,
    includedChannels,
    droppedChannels,
    openMentions,
  };
}

/**
 * Run an async mapper over items with a small concurrency cap. Twenty channel
 * summaries at once would be a burst of parallel API calls for no gain; four keeps
 * the map stage fast without spiking.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {string} channelLabel
 * @returns {string}
 */
function buildChannelSummarySystemPrompt(channelLabel) {
  return `You are compressing one week of a single INTERNAL Slack channel at Pixelup Labs, a design agency, \
into a note that will be used to write the agency's weekly review. The channel is ${channelLabel}. It is a \
team-only channel — no clients are in it.

The transcript is grouped under day headings so you can follow the order things happened in.

Output EXACTLY these four labelled lines, nothing before or after, no markdown, no preamble:

STATE: one sentence on where this work stands as of the end of the week.
MOVED: 2-5 short bullets ("- ") on what actually changed over the week, oldest first, each naming the day it \
happened. Progress and decisions only — not every message.
BLOCKED: one bullet per thing that is stuck, naming who it is waiting on. Write "none" if nothing is.
OPEN: one bullet per question still unanswered at the end of the week, naming who asked. Write "none" if nothing is.

Rules. Write only what the transcript supports — never guess a cause, an owner, a status, or a date. If the week \
was just chatter with no real progress, say so in STATE and put "none" in MOVED. Attribute people by their Slack \
mention exactly as it appears (<@U123>); never invent a name. Keep the whole thing under 200 words.`;
}

/**
 * The weekly map stage: one toolless turn per active channel, each with that
 * channel's full week to itself.
 *
 * A channel whose summary call fails falls back to its raw compacted text rather
 * than dropping out of the review — a degraded section beats a silent hole.
 * @param {{ active: Array<BriefChannel & { messageCount: number, text: string, activeDays?: number }>, conventions: import('../config/index.js').Conventions, query?: typeof query, logger?: { info: Function, error: Function } }} args
 * @returns {Promise<Array<{ channel: BriefChannel & { messageCount: number, activeDays?: number }, label: string, summary: string, failed: boolean }>>}
 */
export async function summarizeChannels({ active, conventions, query: queryFn, logger }) {
  const run = queryFn || query;

  return mapWithConcurrency(active, SUMMARY_CONCURRENCY, async (ch) => {
    const clientName = ch.clientKey ? conventions.clients[ch.clientKey]?.display_name : undefined;
    const label = clientName ? `#${ch.name} (client: ${clientName})` : `#${ch.name}`;
    try {
      /** @type {string[]} */
      const parts = [];
      for await (const message of run({
        prompt:
          `${untrusted(ch.text, `#${ch.name} — one week of messages`)}\n\n` +
          "Summarize this channel's week now, in the four labelled lines.",
        options: {
          model: MODEL,
          systemPrompt: buildChannelSummarySystemPrompt(label),
          maxTurns: 1,
          // tools: [] REMOVES the built-in tools; allowedTools: [] alone only
          // refuses to auto-approve them, so a stray tool-use attempt would burn
          // the single turn and fail the whole call with "max turns reached".
          tools: [],
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
      const summary = parts.join('\n').trim().slice(0, CHANNEL_SUMMARY_MAX_CHARS);
      if (!summary) throw new Error('empty summary');
      return { channel: ch, label, summary, failed: false };
    } catch (e) {
      logger?.error(`Weekly review: could not summarize #${ch.name} (${e}); falling back to raw messages.`);
      return {
        channel: ch,
        label,
        summary: `[Summary unavailable for this channel — raw messages follow.]\n${ch.text.slice(0, 4000)}`,
        failed: true,
      };
    }
  });
}

/**
 * Assemble the weekly reduce prompt from the per-channel summaries.
 *
 * Every project arrives at comparable depth here, which is the whole point of the
 * map stage: cross-project selection is a real judgment instead of an artifact of
 * which channel happened to fit the budget.
 *
 * NO mention block, on purpose. "Needs you" is a daily-brief concept: a mention
 * ages out of actionability within hours ("joining the call?"), so over a seven-day
 * window the code-derived list fills with dead asks and cc's that outrank real
 * blockers. The weekly review instead closes on where each project STANDS —
 * blockers and open questions surface through the per-channel summaries' BLOCKED
 * and OPEN lines, carrying who they wait on.
 * @param {{ summaries: Array<{ channel: BriefChannel & { messageCount: number, activeDays?: number }, label: string, summary: string, failed: boolean }>, quiet?: BriefChannel[], conventions: import('../config/index.js').Conventions, since: string, until: string, totalMaxChars?: number }} args
 * @returns {{ text: string, includedChannels: string[], droppedChannels: string[], failedSummaries: string[] }}
 */
export function buildWeeklyDigest({
  summaries,
  quiet = [],
  conventions,
  since,
  until,
  totalMaxChars = MODES.weekly.totalMaxChars,
}) {
  const byVolume = [...summaries].sort((a, b) => b.channel.messageCount - a.channel.messageCount);
  /** @type {string[]} */
  const sections = [];
  /** @type {string[]} */
  const includedChannels = [];
  /** @type {string[]} */
  const droppedChannels = [];
  let size = 0;

  for (const s of byVolume) {
    const days = s.channel.activeDays ? `, active on ${s.channel.activeDays} day(s)` : '';
    const section = `=== ${s.label} — ${s.channel.messageCount} message(s) this week${days} ===\n${s.summary}`;
    if (size + section.length > totalMaxChars && includedChannels.length > 0) {
      droppedChannels.push(`#${s.channel.name}`);
      continue;
    }
    size += section.length + 2;
    sections.push(section);
    includedChannels.push(`#${s.channel.name}`);
  }

  const quietLabels = quiet
    .map((ch) => (ch.clientKey ? conventions.clients[ch.clientKey]?.display_name : undefined) || `#${ch.name}`)
    .sort((a, b) => a.localeCompare(b));

  const header =
    `WEEKLY REVIEW. Window: ${since} → ${until} (the last 7 days).\n` +
    "Each section below is a per-channel summary of that channel's whole week, already compressed from the " +
    'raw messages. Treat each as the record for that project.\n' +
    `Projects with activity: ${includedChannels.length}\n` +
    (quietLabels.length
      ? `Projects with NO activity ALL WEEK (name these in the "no update" line): ${quietLabels.join(', ')}\n`
      : '') +
    (droppedChannels.length
      ? `NOTE: ${droppedChannels.length} channel(s) omitted for size — ${droppedChannels.join(', ')}. Say so at the end.\n`
      : '');

  return {
    text: `${header}\n${sections.join('\n\n')}`,
    includedChannels,
    droppedChannels,
    failedSummaries: summaries.filter((s) => s.failed).map((s) => `#${s.channel.name}`),
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
in under a minute. Assume they have not read Slack. This is a project-status synthesis, NOT a recap of the last \
few messages.

Write only what the digest supports. Never guess at a cause, an owner, or a status that isn't there. Say "no \
update" for a project rather than inventing progress, and never pad — a short brief is a good brief.

HOW TO INTERPRET THE SLACK EVIDENCE — do this before writing:

1. Within each channel, group related messages and thread replies into distinct workstreams, deliverables, or \
decisions. A channel may contain more than one.
2. Read each workstream from earliest to latest. Reconstruct the arc: the original task or question, the \
material development, and the latest supported state. A later approval or answer supersedes an earlier blocker \
or open question.
3. Extract only consequential signals: completed work, decisions, approvals, rejections, explicit deadlines or \
urgency, blockers, scope changes, handoffs, and concrete next steps.
4. Discard greetings, acknowledgements, routine coordination, repeated status statements, and intermediate \
messages that a later message resolves or supersedes. Do not quote or paraphrase a sequence message-by-message.
5. Correlate related statements across the channel and its threads. Do not treat the newest message as the \
essence merely because it came last.
6. Use timeline or priority language ONLY when Slack states or clearly demonstrates it. With no supported \
timeline, priority, owner, or next step, omit that field rather than guessing.

Agency voice: ${voice}

Output Slack mrkdwn only (*bold*, "• " bullets, <#C123> is fine to echo back if present — no "#" headings, \
no tables, no links you were not given).

The brief has exactly TWO parts, in this order. Both headers always appear.

*:one: Where every project stands*

This is the main event — the founder's picture of the whole agency. One bullet per active project. Order projects \
by what matters operationally: blockers and explicit deadline risk first, then decisions/approvals needed, \
material completions or changes, and routine progress last. Never rank by message count.

• *{Client}* — capture the essence of the work, not the conversation: what materially changed and why it matters; \
where the project stands now; then the next concrete step and owner when stated. Fold supported timeline, urgency, \
blockers, and unanswered questions into the same bullet. If multiple unrelated workstreams materially moved, \
separate them clearly inside the bullet. Three compact sentences at most.

Do not write chronological play-by-play ("A said..., then B said..."). Do not merely repeat the last message. \
Prefer a status conclusion such as "approved and ready for handoff" over the messages that led to it.

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
in parens where it helps them go look. Keep the whole brief under 550 words. No preamble, no sign-off, at most \
one emoji beyond the two part markers.`;
}

/**
 * The weekly reduce prompt. Kept separate from the daily one rather than
 * parameterized: the daily prompt is tuned tight around "before their day starts"
 * and 550 words, and stretching it with conditionals would make both worse.
 *
 * There is deliberately NO "Needs you" here — see `buildWeeklyDigest`. The review
 * answers two questions instead: what happened, and where does every project stand
 * NOW. "Now" is anchored on each week's latest activity, since the freshest signal
 * of a project's state is the last thing that happened in it.
 * @param {string} voice
 * @param {{ name: string, id: string }} recipient
 * @returns {string}
 */
function buildWeeklySystemPrompt(voice, recipient) {
  return `You are Pixelup Bot writing the WEEKLY REVIEW for ${recipient.name} at Pixelup Labs, a design agency. \
Your input is a set of per-channel summaries covering the last seven days of the agency's INTERNAL Slack channels \
(team only — no clients are in these channels). This review is delivered as a private DM to ${recipient.name}.

THE READER IS ${recipient.name}, whose Slack ID is ${recipient.id} — they appear as <@${recipient.id}>. \
Any other <@U…> is a colleague, never the reader.

This is a week in review, not a daily update, and it answers exactly two questions: what happened last week, and \
where does everything stand right now. Your job is selection: seven days of work will not fit, and it should not. \
Lead with what changed the agency's position — shipped work, decisions, things that slipped, things that are \
stuck. Routine back-and-forth that went nowhere is not worth a line.

Write only what the summaries support. Never guess at a cause, an owner, or a status that isn't there. Say "no \
update" for a project rather than inventing progress. A project that was silent all week is itself worth saying.

Agency voice: ${voice}

Output Slack mrkdwn only (*bold*, "• " bullets, <#C123> is fine to echo back if present — no "#" headings, \
no tables, no links you were not given).

The review has exactly TWO parts, in this order. Both headers always appear.

*:one: What happened last week*

One bullet per active project, most consequential first:

• *{Client}* — the arc of the week: what moved, what shipped, what was decided. Name the day when the timing \
matters ("slipped Wednesday", "approved Friday"). Story only — save the current state for part 2. Two sentences \
at most.

Then, if any internal (non-client) channels saw activity, one final bullet "• *Internal* — …" covering them \
together. If some projects were silent all week, close the part with one line: "_No update: X, Y, Z._"

*:two: Where we stand now*

The snapshot ${recipient.name} carries into this week. One bullet per active project, same order as part 1:

• *{Client}* — the project's state as of the END of the week: draw it from each summary's STATE line and from \
the latest-dated activity, not from how the week started — if Wednesday said "blocked" and Friday said "shipped", \
the state is shipped. Fold in what is blocked or still open from the BLOCKED and OPEN lines, naming who each \
item waits on. One or two sentences.

Skip a project here only if its part 1 bullet already says it closed the week clean with nothing pending — \
never repeat a bullet just to say "nothing pending".

Attribute people by their Slack mention exactly as it appears (<@U123>) — do not invent names. Put the channel \
in parens where it helps them go look. Keep the whole review under 800 words. No preamble, no sign-off, at most \
one emoji beyond the two part markers.`;
}

/**
 * Write the brief. Reads nothing, posts nothing, has no tools.
 * @param {string} digest
 * @param {{ conventions?: import('../config/index.js').Conventions, recipient?: { name: string, id: string }, query?: typeof query, mode?: BriefMode }} [options]
 * @returns {Promise<string>}
 */
export async function summarizeBrief(digest, options = {}) {
  const conventions = options.conventions || loadConventions();
  const queryFn = options.query || query;
  const recipient = options.recipient || { name: 'the reader', id: 'unknown' };
  const mode = options.mode || 'daily';

  const prompt =
    `${untrusted(digest, mode === 'weekly' ? 'Weekly channel summaries' : 'Slack digest')}\n\n` +
    (mode === 'weekly'
      ? 'Write the weekly review now, following the structure in your instructions.'
      : 'Write the founder brief now, following the structure in your instructions.');

  /** @type {string[]} */
  const parts = [];
  for await (const message of queryFn({
    prompt,
    options: {
      model: MODEL,
      systemPrompt:
        mode === 'weekly'
          ? buildWeeklySystemPrompt(conventions.agency.voice, recipient)
          : buildSystemPrompt(conventions.agency.voice, recipient),
      maxTurns: 1,
      // tools: [] REMOVES the built-in tools (allowedTools alone only skips
      // auto-approval) — a stray tool-use attempt would otherwise burn the single
      // turn and fail the run with "max turns reached".
      tools: [],
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
 * `mode` is normally derived from the weekday (`weekly_review.day` → weekly, else
 * daily); passing it explicitly is how the CLI previews Monday's review on a Tuesday.
 * @param {{ client: import('@slack/web-api').WebClient, logger?: { info: Function, error: Function }, conventions?: import('../config/index.js').Conventions, recipientId?: string, deliverTo?: string, since?: string, until?: string, deliver?: boolean, query?: typeof query, mode?: BriefMode }} args
 * @returns {Promise<{ brief: string, digest: string, mode: BriefMode, active: Array<{ name: string, messageCount: number, threadsExpanded: number, activeDays: number }>, quiet: string[], unreadable: Array<{ name: string, error: string }>, excluded: Array<{ name: string, reason: string }>, skipped: Array<{ name: string, reason: string }>, mentions: Array<{ channel: string, author: string, ts: string, text: string, answered: boolean }>, recipientName: string, missing: Array<{ id: string, reason: string }>, deliveredTo: string | null, since: string, until: string }>}
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
  mode: modeOverride,
}) {
  const conventions = given || loadConventions();
  const cfg = conventions.daily_brief || {};
  const sendTo = deliverTo || recipientId;
  const timezone = cfg.timezone || DEFAULT_TIMEZONE;
  const now = new Date();
  const parts = zonedParts(now, timezone);
  // An explicit mode brings its own window, or previewing a weekly review on a
  // Tuesday would summarize 24 hours and call it a week.
  const window = windowHoursFor(parts.weekday, cfg, modeOverride);
  const mode = window.mode;
  const windowSince = since || windowStart(now, window.lookbackHours);
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
    scanHours: window.scanHours,
    // "Needs you" is a daily-brief concept — a week-old @-mention is a dead ask,
    // not a blocker. No recipient here means no mention is ever collected, so a
    // stale one cannot leak into the weekly review by any path.
    recipientId: mode === 'weekly' ? '' : recipient.id,
    mode,
    timezone,
  });

  const summary = {
    mode,
    active: active.map((c) => ({
      name: `#${c.name}`,
      messageCount: c.messageCount,
      threadsExpanded: c.threadsExpanded,
      activeDays: c.activeDays,
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
    const brief =
      mode === 'weekly'
        ? '*Weekly review* — no internal channel activity in the last week. Nothing to report. :sunny:'
        : '*Morning brief* — no internal channel activity in the window. Nothing to report. :sunny:';
    let deliveredTo = null;
    if (deliver && sendTo) deliveredTo = await deliverBrief({ client, recipientId: sendTo, text: brief });
    logger?.info(`${mode === 'weekly' ? 'Weekly review' : 'Daily brief'}: no activity in window.`);
    return { ...summary, digest: '', brief, deliveredTo };
  }

  /** @type {string} */
  let digest;
  /** @type {string[]} */
  let droppedChannels;
  /** @type {string[]} */
  let failedSummaries = [];

  if (mode === 'weekly') {
    // Map: one toolless turn per channel, each with its own week to itself.
    logger?.info(`Weekly review: summarizing ${active.length} channel(s).`);
    const summaries = await summarizeChannels({ active, conventions, query: queryFn, logger });
    const built = buildWeeklyDigest({
      summaries,
      quiet,
      conventions,
      since: windowSince,
      until: windowUntil,
    });
    digest = built.text;
    droppedChannels = built.droppedChannels;
    failedSummaries = built.failedSummaries;
  } else {
    const built = buildDigest({
      active,
      quiet,
      mentions,
      recipientName: recipient.name,
      conventions,
      since: windowSince,
      until: windowUntil,
    });
    digest = built.text;
    droppedChannels = built.droppedChannels;
  }

  // Reduce (weekly) / write-up (daily) — same call, different prompt.
  const brief = await summarizeBrief(digest, { conventions, recipient, query: queryFn, mode });

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
  if (failedSummaries.length) {
    footnotes.push(`_Summarizing failed for ${failedSummaries.join(', ')} — those sections are less reliable._`);
  }
  const text = footnotes.length ? `${brief}\n\n${footnotes.join('\n')}` : brief;

  let deliveredTo = null;
  if (deliver && sendTo) deliveredTo = await deliverBrief({ client, recipientId: sendTo, text });
  logger?.info(
    `${mode === 'weekly' ? 'Weekly review' : 'Daily brief'}: ${active.length} active channel(s), delivered=${Boolean(deliveredTo)}.`,
  );

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
  const weeklyNote = cfg.weekly_review?.enabled
    ? `, ${cfg.weekly_review.day || DEFAULT_WEEKLY_DAY} is a weekly review`
    : '';
  logger.info(
    `Daily brief scheduler started (${schedule.days.join('/')} ${schedule.hour}:${String(schedule.minute).padStart(2, '0')} ${timezone} → DM ${recipientId}${weeklyNote}).`,
  );
  return handle;
}
