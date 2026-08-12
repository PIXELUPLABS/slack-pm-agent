import { runPixelupAgent } from '../../agent/index.js';
import { loadConventions } from '../../config/index.js';
import { canBotPostInChannel } from '../../config/resolver.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * Every `<@ID>` mention in a leading run at the very start of the text
 * (whitespace/commas between them are fine), e.g. for `"<@U1> <@U2> do X"`
 * this returns `['U1', 'U2']`. Once anything else appears, the run stops —
 * a mention buried later in a sentence is not part of it.
 * @param {string} text
 * @returns {string[]}
 */
function leadingMentionIds(text) {
  const match = (text || '').match(/^(?:\s*<@([A-Z0-9]+)>[,:]?\s*)+/);
  if (!match) return [];
  return [...match[0].matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
}

/**
 * Handle app_mention events and run the Pixelup agent.
 *
 * A mention only counts as a request when the bot is addressed AT THE START
 * of the message (alone, or alongside other people in the same leading
 * mention block) — never a bare reference dropped anywhere else in a longer
 * message ("...perfect time to leverage @PixelupBot..."). That's a real
 * message shape the team uses (a broadcast update naming the bot in passing
 * without asking it anything), and Slack still fires `app_mention` for it, so
 * this has to be filtered in code rather than assumed away. Deterministic by
 * design, same reasoning as `parseIssueKeyword` — never the model's
 * judgement call, since running the agent unprompted is not undoable (it
 * posts a reply).
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  try {
    const channelId = event.channel;
    const rawText = event.text || '';

    const leadingIds = leadingMentionIds(rawText);
    // context.botUserId is the bot's own Slack ID (Bolt-provided). Without it
    // (defensive — shouldn't happen at runtime) fall back to "some mention
    // leads the message", since Slack only fired this event because the bot
    // was mentioned somewhere.
    const isDirectedAtBot = context.botUserId ? leadingIds.includes(context.botUserId) : leadingIds.length > 0;
    if (!isDirectedAtBot) {
      logger.info(`Ignored app_mention in ${channelId}: bot was only referenced, not addressed at the start.`);
      return;
    }

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

    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);

    // Strip the bot mention from the text
    const cleanedText = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

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
    const deps = {
      client,
      userId,
      channelId,
      threadTs,
      messageTs: event.ts,
      channelType: /** @type {any} */ (event).channel_type,
      userToken: context.userToken,
    };
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
