import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { proposalStore } from '../../../approvals/store.js';
import { handleProposalApprove, handleProposalReject } from '../../../listeners/actions/approval-buttons.js';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = new URL('../../fixtures/conventions.json', import.meta.url).pathname;

// Slack IDs from the fixture.
const LEAD_ID = 'U0000000LEAD';
const MEMBER_ID = 'U000000MEMBR';
const CLIENT_KEY = 'example-client';

describe('approval buttons', () => {
  let fakeAck;
  let fakeClient;
  let fakeLogger;
  let fakeRespond;

  beforeEach(() => {
    delete process.env.CLICKUP_API_TOKEN;
    fakeAck = mock.fn(async () => {});
    fakeClient = { chat: { update: mock.fn(async () => ({ ok: true })) } };
    fakeLogger = { error: mock.fn(), info: mock.fn() };
    fakeRespond = mock.fn(async () => {});
  });

  /** @param {string} userId @param {string} proposalId */
  function body(userId, proposalId) {
    return { user: { id: userId }, actions: [{ value: proposalId }] };
  }

  it('acks and reports expired/unknown proposals', async () => {
    await handleProposalApprove({
      ack: fakeAck,
      body: body(LEAD_ID, 'missing-id'),
      client: fakeClient,
      logger: fakeLogger,
      respond: fakeRespond,
    });
    assert.strictEqual(fakeAck.mock.callCount(), 1);
    assert.ok(fakeRespond.mock.calls[0].arguments[0].text.includes('expired'));
    assert.strictEqual(fakeClient.chat.update.mock.callCount(), 0);
  });

  it('blocks members from approving client updates (lead-only)', async () => {
    const proposal = proposalStore.create({
      type: 'client_update',
      payload: { clientKey: CLIENT_KEY, draft: 'Update…' },
      requesterId: LEAD_ID,
      clientKey: CLIENT_KEY,
    });
    proposalStore.attachMessage(proposal.id, 'C0DRAFTS', '1.1');
    await handleProposalApprove({
      ack: fakeAck,
      body: body(MEMBER_ID, proposal.id),
      client: fakeClient,
      logger: fakeLogger,
      respond: fakeRespond,
    });
    assert.ok(fakeRespond.mock.calls[0].arguments[0].text.includes('Only leads'));
    assert.strictEqual(proposalStore.get(proposal.id)?.status, 'pending');
    assert.strictEqual(fakeClient.chat.update.mock.callCount(), 0);
  });

  it('lead approval of a client update executes and updates the card', async () => {
    const proposal = proposalStore.create({
      type: 'client_update',
      payload: { clientKey: CLIENT_KEY, draft: 'Update…' },
      requesterId: LEAD_ID,
      clientKey: CLIENT_KEY,
    });
    proposalStore.attachMessage(proposal.id, 'C0DRAFTS', '1.2');
    await handleProposalApprove({
      ack: fakeAck,
      body: body(LEAD_ID, proposal.id),
      client: fakeClient,
      logger: fakeLogger,
      respond: fakeRespond,
    });
    assert.strictEqual(proposalStore.get(proposal.id)?.status, 'executed');
    assert.strictEqual(fakeClient.chat.update.mock.callCount(), 1);
    const updateArgs = fakeClient.chat.update.mock.calls[0].arguments[0];
    assert.strictEqual(updateArgs.channel, 'C0DRAFTS');
    assert.strictEqual(updateArgs.ts, '1.2');
  });

  it('marks the proposal failed when execution fails (e.g. ClickUp not configured)', async () => {
    const proposal = proposalStore.create({
      type: 'task',
      payload: { clientKey: CLIENT_KEY, title: 'Fix header' },
      requesterId: MEMBER_ID,
      clientKey: CLIENT_KEY,
    });
    proposalStore.attachMessage(proposal.id, 'D0MEMBER', '1.3');
    await handleProposalApprove({
      ack: fakeAck,
      body: body(MEMBER_ID, proposal.id),
      client: fakeClient,
      logger: fakeLogger,
      respond: fakeRespond,
    });
    assert.strictEqual(proposalStore.get(proposal.id)?.status, 'failed');
    assert.strictEqual(fakeClient.chat.update.mock.callCount(), 1);
    assert.strictEqual(fakeLogger.error.mock.callCount(), 1);
  });

  it('reject closes the proposal without writing', async () => {
    const proposal = proposalStore.create({
      type: 'task',
      payload: { clientKey: CLIENT_KEY, title: 'Fix header' },
      requesterId: MEMBER_ID,
      clientKey: CLIENT_KEY,
    });
    proposalStore.attachMessage(proposal.id, 'D0MEMBER', '1.4');
    await handleProposalReject({
      ack: fakeAck,
      body: body(LEAD_ID, proposal.id),
      client: fakeClient,
      logger: fakeLogger,
      respond: fakeRespond,
    });
    assert.strictEqual(proposalStore.get(proposal.id)?.status, 'rejected');
    assert.strictEqual(fakeClient.chat.update.mock.callCount(), 1);
  });

  it('reject requires a configured team member', async () => {
    const proposal = proposalStore.create({
      type: 'task',
      payload: { clientKey: CLIENT_KEY, title: 'Fix header' },
      requesterId: MEMBER_ID,
      clientKey: CLIENT_KEY,
    });
    await handleProposalReject({
      ack: fakeAck,
      body: body('U0STRANGER', proposal.id),
      client: fakeClient,
      logger: fakeLogger,
      respond: fakeRespond,
    });
    assert.strictEqual(proposalStore.get(proposal.id)?.status, 'pending');
    assert.ok(fakeRespond.mock.calls[0].arguments[0].text.includes('team members'));
  });
});
