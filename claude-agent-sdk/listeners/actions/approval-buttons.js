import { buildResolvedCard } from '../../approvals/card-builder.js';
import { canApprove, executeProposal } from '../../approvals/executor.js';
import { proposalStore } from '../../approvals/store.js';
import { loadConventions } from '../../config/index.js';

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {import('../../approvals/store.js').Proposal} proposal
 * @param {import('@slack/types').KnownBlock[]} blocks
 * @returns {Promise<void>}
 */
async function updateCard(client, proposal, blocks) {
  if (!proposal.channelId || !proposal.messageTs) return;
  await client.chat.update({
    channel: proposal.channelId,
    ts: proposal.messageTs,
    text: 'Proposal resolved',
    blocks,
  });
}

/**
 * Approve button: permission check (in code, against config roles), then the
 * deterministic executor runs the write. The agent is never involved here.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleProposalApprove({ ack, body, client, logger, respond }) {
  await ack();

  try {
    const conventions = loadConventions();
    const proposalId = body.actions[0].value;
    const userId = body.user.id;
    const proposal = proposalId ? proposalStore.get(proposalId) : null;

    if (!proposal || proposal.status !== 'pending') {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'This proposal has expired or was already resolved.',
      });
      return;
    }

    if (!canApprove(proposal, userId, conventions)) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text:
          proposal.type === 'scaffold' || proposal.type === 'client_update'
            ? 'Only leads can approve project scaffolds and client-facing drafts.'
            : 'Only the requester or a lead can approve this.',
      });
      return;
    }

    proposalStore.setStatus(proposal.id, 'approved');
    try {
      // `client` (bot Web API) is needed for canvas writes; clickup defaults inside.
      const result = await executeProposal(proposal, conventions, undefined, client);
      proposalStore.setStatus(proposal.id, 'executed');
      await updateCard(
        client,
        proposal,
        buildResolvedCard(proposal, { outcome: 'executed', actorId: userId, detail: result.summary }),
      );
    } catch (e) {
      proposalStore.setStatus(proposal.id, 'failed');
      const message = /** @type {Error} */ (e).message;
      logger.error(`Proposal ${proposal.id} execution failed: ${message}`);
      await updateCard(
        client,
        proposal,
        buildResolvedCard(proposal, { outcome: 'failed', actorId: userId, detail: `:warning: ${message}` }),
      );
    }
  } catch (e) {
    logger.error(`Failed to handle proposal approval: ${e}`);
  }
}

/**
 * Reject button: anyone in the team config can reject; the proposal is closed
 * and nothing is written.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleProposalReject({ ack, body, client, logger, respond }) {
  await ack();

  try {
    const conventions = loadConventions();
    const proposalId = body.actions[0].value;
    const userId = body.user.id;
    const proposal = proposalId ? proposalStore.get(proposalId) : null;

    if (!proposal || proposal.status !== 'pending') {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'This proposal has expired or was already resolved.',
      });
      return;
    }

    if (!conventions.users[userId]) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'Only team members in the config can act on proposals.',
      });
      return;
    }

    proposalStore.setStatus(proposal.id, 'rejected');
    await updateCard(client, proposal, buildResolvedCard(proposal, { outcome: 'rejected', actorId: userId }));
  } catch (e) {
    logger.error(`Failed to handle proposal rejection: ${e}`);
  }
}
