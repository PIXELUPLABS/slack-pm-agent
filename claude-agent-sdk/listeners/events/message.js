import { runPixelupAgent } from '../../agent/index.js';
import { loadConventions } from '../../config/index.js';
import { canBotPostInChannel } from '../../config/resolver.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * True for messages the bot should process: plain messages AND file shares
 * (uploading a doc sets subtype "file_share" — the engagement-doc onboarding
 * path). Everything else (edits, deletes, joins, …) is skipped.
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isProcessableMessage(event) {
  const subtype = /** @type {any} */ (event).subtype;
  return subtype === undefined || subtype === 'file_share';
}

/**
 * Files seen per thread, so later messages can still reference them — a
 * resumed session (or a forgetful model) can re-read a doc shared earlier
 * instead of asking for it again. In-memory, capped, same tradeoffs as the
 * session store.
 * @type {Map<string, Array<{ id: string, name: string, mimetype: string }>>}
 */
const threadFiles = new Map();
const THREAD_FILES_MAX_THREADS = 500;

/**
 * @param {string} threadKey
 * @param {any[]} files
 * @returns {void}
 */
function rememberThreadFiles(threadKey, files) {
  const existing = threadFiles.get(threadKey) || [];
  const known = new Set(existing.map((f) => f.id));
  for (const file of files) {
    if (!known.has(file.id)) existing.push({ id: file.id, name: file.name, mimetype: file.mimetype });
  }
  threadFiles.set(threadKey, existing.slice(-20));
  if (threadFiles.size > THREAD_FILES_MAX_THREADS) {
    const oldest = threadFiles.keys().next().value;
    if (oldest !== undefined) threadFiles.delete(oldest);
  }
}

/**
 * @typedef {{ event_type: 'issue_submission', event_payload: { user_id: string } }} IssueSubmissionMetadata
 */

/**
 * @param {import('@slack/types').GenericMessageEvent} event
 * @returns {IssueSubmissionMetadata | null}
 */
function getIssueMetadata(event) {
  const metadata = /** @type {any} */ (event).metadata;
  return metadata?.event_type === 'issue_submission' ? metadata : null;
}

/**
 * Handle messages sent to Pixelup Bot via DM or in threads the bot is part of.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.) — but keep file shares.
  if (!isProcessableMessage(event)) return;

  // Enforced in code: outside DMs the bot converses in any channel it has been
  // invited to. Client-facing channels stay read-only — it reads them via
  // tools, but no reply, reaction, or card ever lands there. Name-based and
  // fail-closed; see canBotPostInChannel.
  if (event.channel_type !== 'im') {
    const post = await canBotPostInChannel({
      client,
      conventions: loadConventions(),
      channelId: event.channel,
      channelType: event.channel_type,
    });
    if (!post.allowed) {
      logger.info(`Ignored message: ${post.reason}.`);
      return;
    }
  }

  // Issue submissions are posted by the bot with metadata so the message
  // handler can run the agent on behalf of the original user.
  const issueMetadata = getIssueMetadata(event);

  // Skip bot messages that are not issue submissions.
  if (event.bot_id && !issueMetadata) return;

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled only if the bot is already engaged
    const session = sessionStore.getSession(event.channel, /** @type {string} */ (event.thread_ts));
    if (session === null) return;
  } else {
    // Top-level channel messages are handled by app_mentioned
    return;
  }

  try {
    const channelId = event.channel;
    let text = event.text || '';
    const threadTs = event.thread_ts || event.ts;

    // Surface attached files (engagement docs) to the agent so it can read
    // them with the read_shared_file tool — including files shared EARLIER in
    // this thread, so a follow-up message never loses access to the doc.
    const files = /** @type {any} */ (event).files;
    const threadKey = `${channelId}:${threadTs}`;
    if (files?.length) rememberThreadFiles(threadKey, files);
    const knownFiles = threadFiles.get(threadKey);
    if (knownFiles?.length) {
      const fileList = knownFiles.map((f) => `- ${f.name} (id: ${f.id}, type: ${f.mimetype})`).join('\n');
      text += `\n\n[Files shared in this thread (readable with read_shared_file):\n${fileList}]`;
    }

    // For issue submissions the bot posted the message, so the real
    // user_id comes from the metadata rather than the event context.
    const userId = /** @type {string} */ (issueMetadata ? issueMetadata.event_payload.user_id : context.userId);

    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // Add eyes reaction only to the first message (DMs only — channel
    // threads already have the reaction from the initial app_mention)
    if (isDm && !existingSessionId) {
      await client.reactions.add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      });
    }

    // Set assistant thread status with loading messages
    await setStatus({
      status: 'Thinking…',
      loading_messages: [
        'Checking ClickUp so you don’t have to…',
        'Lining up the details…',
        'Drafting a proposal for your approval…',
      ],
    });

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
    const { responseText, sessionId: newSessionId } = await runPixelupAgent(text, existingSessionId ?? undefined, deps);

    // Stream response in thread with feedback buttons
    const streamer = sayStream();
    await streamer.append({ markdown_text: responseText });
    const feedbackBlocks = buildFeedbackBlocks();
    await streamer.stop({ blocks: feedbackBlocks });

    // Store conversation session
    if (newSessionId) {
      sessionStore.setSession(channelId, threadTs, newSessionId);
    }
  } catch (e) {
    logger.error(`Failed to handle message: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
