import { buildApprovalCard } from '../../approvals/card-builder.js';
import { endOfWeek } from '../../approvals/scaffold-rules.js';
import { proposalStore } from '../../approvals/store.js';
import { loadConventions } from '../../config/index.js';
import { resolveChannelContext } from '../../config/resolver.js';

/**
 * "Add to ClickUp" message shortcut — the precision path for task intake.
 *
 * Deliberately zero-LLM: the message text is the source of truth, so the
 * proposal is drafted deterministically (title from the first line, verbatim
 * quote attached) and costs nothing in tokens. The approval card lands in the
 * requester's DM; the client channel sees nothing.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackShortcutMiddlewareArgs<import('@slack/bolt').MessageShortcut>} args
 * @returns {Promise<void>}
 */
export async function handleAddToClickUp({ ack, shortcut, client, logger }) {
  await ack();

  try {
    const conventions = loadConventions();
    const userId = shortcut.user.id;
    const channelId = shortcut.channel.id;
    const messageText = shortcut.message.text || '';

    // Which client's channel is this? Resolved live (by channel name) so a new
    // project works before anyone edits config.
    const channelCtx = await resolveChannelContext({ client, conventions, channelId });
    const inClientChannel = channelCtx.kind === 'client-external';

    // Team members only — enforced in code against config. In client-facing
    // channels stay completely silent (no ephemeral either); a client-side guest
    // using the shortcut must see nothing at all. Fail closed: an unidentified
    // channel is treated as client-facing.
    if (!conventions.users[userId]) {
      if (!inClientChannel && channelCtx.resolved) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'You are not in the Pixelup Bot team config — ask a lead to add you.',
        });
      }
      return;
    }

    const clientKeys = Object.keys(conventions.clients);
    const clientKey = channelCtx.clientKey || (clientKeys.length === 1 ? clientKeys[0] : undefined);

    const firstLine = messageText.split('\n')[0].trim();
    const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine || 'Task from Slack message';

    // Anything the client attached to the message rides along onto the task.
    const messageFiles = /** @type {any[]} */ (/** @type {any} */ (shortcut.message).files || []);
    const referenceUrls = messageFiles
      .map((f) => {
        const url = f.permalink || f.url_private;
        return url ? `${f.name || f.title || 'file'}: ${url}` : null;
      })
      .filter(Boolean);

    const proposal = proposalStore.create({
      type: 'task',
      payload: {
        clientKey,
        title,
        priority: undefined,
        // This path can't parse a date out of prose, so the house default
        // applies: end of the current week. Visible on the card before approval.
        dueDate: endOfWeek(),
        sourceQuote: messageText,
        sourceChannelId: channelId,
        sourceTs: shortcut.message.ts,
        ...(referenceUrls.length > 0 && { referenceUrls }),
      },
      requesterId: userId,
      clientKey,
    });

    // Card goes to the requester's DM — never the source (client) channel.
    const dm = await client.conversations.open({ users: userId });
    const dmChannelId = /** @type {string} */ (dm.channel?.id);
    const posted = await client.chat.postMessage({
      channel: dmChannelId,
      text: 'Proposal awaiting approval',
      blocks: buildApprovalCard(proposal),
    });
    proposalStore.attachMessage(proposal.id, dmChannelId, /** @type {string} */ (posted.ts));

    if (!clientKey) {
      await client.chat.postMessage({
        channel: dmChannelId,
        thread_ts: /** @type {string} */ (posted.ts),
        text: 'Heads up: this channel is not mapped to a client in config/conventions.json — the task cannot be created until the mapping exists.',
      });
    }
  } catch (e) {
    logger.error(`Failed to handle Add to ClickUp shortcut: ${e}`);
  }
}
