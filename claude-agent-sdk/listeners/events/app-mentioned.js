import { runPixelupAgent } from '../../agent/index.js';
import { loadConventions } from '../../config/index.js';
import { canBotPostInChannel } from '../../config/resolver.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * Handle app_mention events and run the Pixelup agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  try {
    const channelId = event.channel;

    // Enforced in code: the bot converses in DMs and any channel it has been
    // invited to. Client-facing channels are read-only silence, even when
    // @mentioned, so the client never sees the bot. Decided by channel NAME
    // (`{client}-pixelup`), not by a config ID that can be missing or stale,
    // and fail-closed when the channel can't be identified.
    const post = await canBotPostInChannel({
      client,
      conventions: loadConventions(),
      channelId,
      channelType: /** @type {any} */ (event).channel_type,
    });
    if (!post.allowed) {
      logger.info(`Ignored app_mention: ${post.reason}.`);
      return;
    }

    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);

    // Strip the bot mention from the text
    const cleanedText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!cleanedText) {
      await say({
        text: 'Hey! Tell me what you need — capture a task, check a project status, wrap a QA round, or draft a client update.',
        thread_ts: threadTs,
      });
      return;
    }

    // Add eyes reaction only to the first message (not threaded replies)
    if (!event.thread_ts) {
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

    // Get conversation session
    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
    const { responseText, sessionId: newSessionId } = await runPixelupAgent(
      cleanedText,
      existingSessionId ?? undefined,
      deps,
    );

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
    logger.error(`Failed to handle app mention: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
