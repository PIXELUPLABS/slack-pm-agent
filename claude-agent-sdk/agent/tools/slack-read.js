import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  extractDocxText,
  extractPdfText,
  isDocx,
  isLegacyDoc,
  isPdf,
  isTextLike,
} from '../../integrations/document-reader.js';

/** @param {string} text @returns {{ content: [{ type: 'text', text: string }] }} */
function asResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** Slack's per-request page size for history/replies. Reads paginate over this. */
const HISTORY_PAGE_SIZE = 200;
/** Messages returned when the caller doesn't say how many they want. */
const DEFAULT_HISTORY_LIMIT = 15;
/**
 * Ceiling on ONE read. Not a product cap — "the whole channel" is a supported
 * request — just a backstop so a runaway sweep can't paginate forever.
 */
const MAX_HISTORY_MESSAGES = 5000;
/**
 * Character budget for the text handed back to the model. Messages beyond it
 * are dropped OLDEST-first and the omission is reported, so the model knows to
 * narrow the range instead of silently reasoning over a partial channel.
 */
const MAX_HISTORY_CHARS = 60000;

/**
 * Everything the client attached to a message: Slack file permalinks and the
 * URLs behind link previews. Task intake carries these onto the ClickUp task,
 * so they must survive the compaction.
 * @param {any} m
 * @returns {string[]}
 */
function messageReferences(m) {
  /** @type {string[]} */
  const refs = [];
  for (const f of m.files || []) {
    const url = f.permalink || f.url_private;
    const label = f.name || f.title || f.filetype || 'file';
    refs.push(url ? `${label}: ${url} (id: ${f.id})` : `${label} (id: ${f.id})`);
  }
  for (const a of m.attachments || []) {
    const url = a.title_link || a.original_url || a.app_unfurl_url || a.image_url;
    if (url) refs.push(`${a.title || a.service_name || 'link'}: ${url}`);
  }
  return refs;
}

/**
 * Render messages as compact chronological lines (oldest → newest, the order
 * someone reading the channel would see) within the character budget.
 * @param {any[]} messages
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function compactMessages(messages, options = {}) {
  const lines = messages
    .filter((m) => m.type === 'message' && (m.text || m.files?.length || m.attachments?.length))
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .map((m) => {
      const who = m.user ? `<@${m.user}>` : m.username || 'bot';
      const refs = messageReferences(m);
      const refNote = refs.length ? ` [attached: ${refs.join(' | ')}]` : '';
      const threadNote = m.reply_count ? ` [thread: ${m.reply_count} repl${m.reply_count === 1 ? 'y' : 'ies'}]` : '';
      return `[ts:${m.ts}] ${who}: ${m.text || ''}${refNote}${threadNote}`;
    });

  const maxChars = options.maxChars ?? MAX_HISTORY_CHARS;
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;

  // Over budget: keep the newest messages that fit and say what was dropped.
  /** @type {string[]} */
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > maxChars && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  const dropped = lines.length - kept.length;
  return (
    `[${dropped} older message(s) omitted — this read hit the size cap. Re-read with since_date/until_date ` +
    `to cover the earlier part of the channel.]\n${kept.join('\n')}`
  );
}

/**
 * YYYY-MM-DD → Slack's epoch-seconds timestamp filter.
 * @param {string | undefined} date
 * @returns {string | undefined}
 */
function toSlackTs(date) {
  if (!date) return undefined;
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return undefined;
  return String(Math.floor(ms / 1000));
}

/**
 * Paginated channel history. Slack returns at most ~200 messages per request,
 * so anything larger — up to the entire channel — is assembled here over
 * cursors rather than being capped at one page.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {{ limit?: number, sinceDate?: string, untilDate?: string }} [options]
 * @returns {Promise<{ messages: any[], hasMore: boolean }>} hasMore: messages
 * older than the ones returned still exist in the requested range.
 */
export async function fetchChannelHistory(client, channelId, options = {}) {
  const target = Math.min(options.limit || DEFAULT_HISTORY_LIMIT, MAX_HISTORY_MESSAGES);
  const oldest = toSlackTs(options.sinceDate);
  const latest = toSlackTs(options.untilDate);
  /** @type {any[]} */
  const messages = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    const res = await client.conversations.history({
      channel: channelId,
      limit: Math.min(HISTORY_PAGE_SIZE, target - messages.length),
      ...(cursor && { cursor }),
      ...(oldest && { oldest }),
      ...(latest && { latest }),
    });
    messages.push(...(res.messages || []));
    cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
  } while (cursor && messages.length < target);
  return { messages: messages.slice(0, target), hasMore: Boolean(cursor) };
}

/**
 * All replies in a thread, paginated — long QA threads run past one page.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {Promise<any[]>}
 */
export async function fetchThreadReplies(client, channelId, threadTs) {
  /** @type {any[]} */
  const messages = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: HISTORY_PAGE_SIZE,
      ...(cursor && { cursor }),
    });
    messages.push(...(res.messages || []));
    cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
  } while (cursor && messages.length < MAX_HISTORY_MESSAGES);
  return messages;
}

/** @param {string | undefined} value @returns {boolean} Real Slack channel ID (not a C_TODO_* placeholder). */
function looksLikeChannelId(value) {
  return /^[CDG][A-Z0-9]{5,}$/.test(value || '');
}

/**
 * Resolve the tool's channel argument from config alone: a client key
 * (external client channel), "{key}-internal" / "{key}-pixelup", or a raw
 * channel ID. When config can't produce a real ID, returns the channel NAME
 * to look up live in Slack instead — config accelerates resolution but never
 * gates reading.
 * @param {import('../../config/index.js').Conventions} conventions
 * @param {string} channel
 * @returns {{ id?: string, lookupName?: string }}
 */
export function resolveChannelArg(conventions, channel) {
  const clients = conventions.clients;
  const name = channel.replace(/^#/, '');
  if (looksLikeChannelId(name)) return { id: name };
  let key = null;
  let kind = /** @type {'external' | 'internal'} */ ('external');
  if (clients[name]) {
    key = name;
  } else {
    const match = name.match(/^(.+)-(internal|pixelup)$/);
    if (match && clients[match[1]]) {
      key = match[1];
      kind = match[2] === 'internal' ? 'internal' : 'external';
    }
  }
  if (key) {
    const id = kind === 'internal' ? clients[key].internal_channel_id : clients[key].channel_id;
    if (looksLikeChannelId(id)) return { id };
    // Bare client key → the external channel's conventional name.
    return { lookupName: key === name ? `${key}-pixelup` : name };
  }
  return { lookupName: name };
}

/**
 * Live name→ID lookup over the channels visible to the bot, cached briefly so
 * repeated tool calls in one conversation don't re-list the workspace.
 * @type {{ at: number, byName: Map<string, string> }}
 */
let channelCache = { at: 0, byName: new Map() };
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Test hook. @param {{ at: number, byName: Map<string, string> }} [cache] */
export function resetChannelCache(cache) {
  channelCache = cache || { at: 0, byName: new Map() };
}

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} name
 * @returns {Promise<string | undefined>}
 */
export async function lookupChannelIdByName(client, name) {
  if (channelCache.byName.has(name)) return channelCache.byName.get(name);
  if (Date.now() - channelCache.at < CHANNEL_CACHE_TTL_MS) return undefined;
  /** @type {Map<string, string>} */
  const byName = new Map();
  /** @type {string | undefined} */
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of res.channels || []) {
      if (c.name && c.id) byName.set(c.name, c.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  channelCache = { at: Date.now(), byName };
  return byName.get(name);
}

/**
 * Read-only Slack tools scoped to what the workflows need: reading client
 * channels for task intake, reading QA threads, and reading shared files
 * (engagement docs). The bot reads client channels but NEVER posts there.
 * @param {{ client: import('@slack/web-api').WebClient, channelId: string, threadTs: string }} deps
 * @param {import('../../config/index.js').Conventions} conventions
 * @returns {any[]}
 */
export function createSlackReadTools(deps, conventions) {
  const readChannelMessages = tool(
    'read_channel_messages',
    'Messages from any channel the bot is in — reads paginate, so the whole channel is available, not just one page. ' +
      'Accepts a client key (external client channel), a channel name (e.g. "monumint-internal"), or a raw channel ID. ' +
      'Set entire_channel: true to sweep the full history, or pass a larger limit / a date range. Read-only.',
    {
      channel: z.string().describe('Client key, channel name, or Slack channel ID.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_HISTORY_MESSAGES)
        .optional()
        .describe(`How many of the most recent messages to read. Default ${DEFAULT_HISTORY_LIMIT}.`),
      entire_channel: z
        .boolean()
        .optional()
        .describe(`Read the whole channel history (up to ${MAX_HISTORY_MESSAGES} messages). Overrides limit.`),
      since_date: z.string().optional().describe('Only messages on/after this date (YYYY-MM-DD).'),
      until_date: z.string().optional().describe('Only messages on/before this date (YYYY-MM-DD).'),
    },
    async ({ channel, limit, entire_channel, since_date, until_date }) => {
      try {
        const resolved = resolveChannelArg(conventions, channel);
        let channelId = resolved.id;
        if (!channelId && resolved.lookupName) {
          channelId = await lookupChannelIdByName(deps.client, resolved.lookupName);
        }
        if (!channelId) {
          return asResult(
            `No channel named #${resolved.lookupName || channel} is visible to the bot. Private channels require ` +
              'the bot to be invited (/invite it there). Double-check the exact channel name with the user.',
          );
        }
        // A date range on its own means "everything in that range" — nobody
        // asking for a month of history wants the default 15.
        const wantsAll = entire_channel || (!limit && Boolean(since_date || until_date));
        const { messages, hasMore } = await fetchChannelHistory(deps.client, channelId, {
          limit: wantsAll ? MAX_HISTORY_MESSAGES : limit,
          sinceDate: since_date,
          untilDate: until_date,
        });
        const body = compactMessages(messages);
        if (!body) return asResult('No messages found.');
        // Only a full sweep that still ran out of room is a warning; a bounded
        // read leaving older messages behind is exactly what was asked for.
        const ceilingNote =
          wantsAll && hasMore
            ? ` — stopped at the ${MAX_HISTORY_MESSAGES}-message ceiling, older messages remain unread`
            : '';
        return asResult(`${messages.length} message(s), oldest first${ceilingNote}:\n${body}`);
      } catch (e) {
        const err = /** @type {any} */ (e);
        const hint = err.data?.error === 'not_in_channel' ? ' (the bot must be invited to the channel first)' : '';
        return asResult(`Could not read channel: ${err.data?.error || err.message}${hint}`);
      }
    },
  );

  const readThread = tool(
    'read_slack_thread',
    'All replies in a thread, paginated to the end of the thread. Defaults to the current thread. Read-only.',
    {
      channel_id: z.string().optional(),
      thread_ts: z.string().optional(),
    },
    async ({ channel_id, thread_ts }) => {
      try {
        const messages = await fetchThreadReplies(
          deps.client,
          channel_id || deps.channelId,
          thread_ts || deps.threadTs,
        );
        const text = compactMessages(messages);
        return asResult(text || 'No messages found.');
      } catch (e) {
        const err = /** @type {any} */ (e);
        return asResult(`Could not read thread: ${err.data?.error || err.message}`);
      }
    },
  );

  const readSharedFile = tool(
    'read_shared_file',
    'Read a file shared in Slack (engagement docs, briefs, specs). Handles PDF, Word .docx, and text/markdown ' +
      '— including scanned PDFs. Returns the document text.',
    { file_id: z.string() },
    async ({ file_id }) => {
      try {
        const info = await deps.client.files.info({ file: file_id });
        const file = /** @type {any} */ (info.file);
        if (!file?.url_private) return asResult('File not accessible.');

        const name = file.name || 'file';
        if (isLegacyDoc(file.mimetype, name)) {
          return asResult(
            `"${name}" is a legacy .doc file, which cannot be read directly. Ask for it as .docx or PDF ` +
              '(in Word: File → Save As), or paste the text.',
          );
        }
        const pdf = isPdf(file.mimetype, name);
        const docx = isDocx(file.mimetype, name);
        if (!pdf && !docx && !isTextLike(file.mimetype, file.filetype)) {
          return asResult(
            `"${name}" (${file.mimetype || 'unknown type'}) is not a readable document. Supported: PDF, .docx, ` +
              'text, and markdown — ask for one of those, or for the content pasted in Slack.',
          );
        }

        const response = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${deps.client.token}` },
          // PDFs take longer to pull than a text snippet.
          signal: AbortSignal.timeout(pdf || docx ? 60000 : 15000),
        });
        if (!response.ok) return asResult(`Slack returned ${response.status} downloading "${name}".`);

        if (pdf || docx) {
          const buf = Buffer.from(await response.arrayBuffer());
          // Slack serves an HTML login page instead of the bytes when the token
          // lacks files:read — surfaced plainly rather than as a parse error.
          if (buf.subarray(0, 15).toString('latin1').trimStart().startsWith('<')) {
            return asResult(`Slack did not return the file bytes for "${name}" — the bot may lack files:read access.`);
          }
          const text = pdf ? await extractPdfText(buf, { filename: name }) : extractDocxText(buf);
          return asResult(`Document: ${name}\n\n${text}`);
        }

        const text = await response.text();
        // Cap what flows into the context — engagement docs rarely need more.
        return asResult(text.slice(0, 20000));
      } catch (e) {
        const err = /** @type {any} */ (e);
        return asResult(`Could not read file: ${err.data?.error || err.message}`);
      }
    },
  );

  return [readChannelMessages, readThread, readSharedFile];
}
