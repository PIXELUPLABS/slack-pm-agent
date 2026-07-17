import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** @param {string} text @returns {{ content: [{ type: 'text', text: string }] }} */
function asResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** @param {any[]} messages @returns {string} */
function compactMessages(messages) {
  return messages
    .filter((m) => m.type === 'message' && (m.text || m.files?.length))
    .map((m) => {
      const who = m.user ? `<@${m.user}>` : m.username || 'bot';
      const fileNote = m.files?.length
        ? ` [files: ${m.files.map((/** @type {any} */ f) => `${f.name} (id: ${f.id})`).join(', ')}]`
        : '';
      return `[ts:${m.ts}] ${who}: ${m.text || ''}${fileNote}`;
    })
    .join('\n');
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
    'Recent messages from any channel the bot is in. Accepts a client key (external client channel), ' +
      'a channel name (e.g. "monumint-internal"), or a raw channel ID. Read-only.',
    {
      channel: z.string().describe('Client key, channel name, or Slack channel ID.'),
      limit: z.number().int().min(1).max(30).optional().describe('Default 15.'),
    },
    async ({ channel, limit }) => {
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
        const result = await deps.client.conversations.history({ channel: channelId, limit: limit || 15 });
        const text = compactMessages(result.messages || []);
        return asResult(text || 'No messages found.');
      } catch (e) {
        const err = /** @type {any} */ (e);
        const hint = err.data?.error === 'not_in_channel' ? ' (the bot must be invited to the channel first)' : '';
        return asResult(`Could not read channel: ${err.data?.error || err.message}${hint}`);
      }
    },
  );

  const readThread = tool(
    'read_slack_thread',
    'All replies in a thread. Defaults to the current thread. Read-only.',
    {
      channel_id: z.string().optional(),
      thread_ts: z.string().optional(),
    },
    async ({ channel_id, thread_ts }) => {
      try {
        const result = await deps.client.conversations.replies({
          channel: channel_id || deps.channelId,
          ts: thread_ts || deps.threadTs,
          limit: 100,
        });
        const text = compactMessages(result.messages || []);
        return asResult(text || 'No messages found.');
      } catch (e) {
        const err = /** @type {any} */ (e);
        return asResult(`Could not read thread: ${err.data?.error || err.message}`);
      }
    },
  );

  const readSharedFile = tool(
    'read_shared_file',
    'Text content of a file shared in Slack (engagement docs). Text-based files only.',
    { file_id: z.string() },
    async ({ file_id }) => {
      try {
        const info = await deps.client.files.info({ file: file_id });
        const file = /** @type {any} */ (info.file);
        if (!file?.url_private) return asResult('File not accessible.');
        const isTextLike =
          /^text\//.test(file.mimetype || '') || ['post', 'markdown', 'quip'].includes(file.filetype || '');
        if (!isTextLike) {
          return asResult(
            `File "${file.name}" (${file.mimetype}) is not a text file — ask the user to paste the content or share a text/markdown version.`,
          );
        }
        const response = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${deps.client.token}` },
          signal: AbortSignal.timeout(15000),
        });
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
