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
    'Recent messages from a channel. Accepts a client key from conventions or a raw channel ID. Read-only.',
    {
      channel: z.string().describe('Client key or Slack channel ID.'),
      limit: z.number().int().min(1).max(30).optional().describe('Default 15.'),
    },
    async ({ channel, limit }) => {
      try {
        const channelId = conventions.clients[channel]?.channel_id || channel;
        const result = await deps.client.conversations.history({ channel: channelId, limit: limit || 15 });
        const text = compactMessages(result.messages || []);
        return asResult(text || 'No messages found.');
      } catch (e) {
        const err = /** @type {any} */ (e);
        return asResult(`Could not read channel: ${err.data?.error || err.message}`);
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
