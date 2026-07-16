import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildApprovalCard, buildResolvedCard } from '../../approvals/card-builder.js';

/** @returns {import('../../approvals/store.js').Proposal} */
function taskProposal() {
  return {
    id: 'p-1',
    type: 'task',
    payload: {
      clientKey: 'acme',
      title: 'Fix header',
      priority: 'high',
      dueDate: '2026-07-20',
      sourceQuote: 'Please fix the header\nIt overlaps the logo',
    },
    requesterId: 'U1',
    status: 'pending',
    createdAt: Date.now(),
  };
}

describe('buildApprovalCard', () => {
  it('includes approve and reject buttons carrying the proposal id', () => {
    const blocks = buildApprovalCard(taskProposal());
    const actions = blocks.find((b) => b.type === 'actions');
    assert.ok(actions);
    const ids = actions.elements.map((e) => e.action_id);
    assert.deepStrictEqual(ids, ['proposal_approve', 'proposal_reject']);
    for (const element of actions.elements) {
      assert.strictEqual(element.value, 'p-1');
    }
  });

  it('summarizes the task payload including the source quote', () => {
    const blocks = buildApprovalCard(taskProposal());
    const summary = blocks[1].text.text;
    assert.ok(summary.includes('Fix header'));
    assert.ok(summary.includes('acme'));
    assert.ok(summary.includes('> Please fix the header'));
    assert.ok(summary.includes('> It overlaps the logo'));
  });

  it('summarizes qa_tasks batches with a count', () => {
    const blocks = buildApprovalCard({
      id: 'p-2',
      type: 'qa_tasks',
      payload: {
        clientKey: 'acme',
        tasks: [
          { title: 'Button misaligned', page: 'Home', device: 'mobile', severity: 'high' },
          { title: 'Typo in footer' },
        ],
      },
      requesterId: 'U1',
      status: 'pending',
      createdAt: Date.now(),
    });
    const summary = blocks[1].text.text;
    assert.ok(summary.includes('2 task(s)'));
    assert.ok(summary.includes('[Home / mobile] Button misaligned'));
  });

  it('mentions the requester in context', () => {
    const blocks = buildApprovalCard(taskProposal());
    const context = blocks.find((b) => b.type === 'context');
    assert.ok(context.elements[0].text.includes('<@U1>'));
  });
});

describe('buildResolvedCard', () => {
  it('renders executed outcome with detail and no buttons', () => {
    const blocks = buildResolvedCard(taskProposal(), {
      outcome: 'executed',
      actorId: 'U2',
      detail: 'Task created: link',
    });
    assert.ok(!blocks.some((b) => b.type === 'actions'));
    assert.ok(blocks[0].text.text.includes('Approved & executed'));
    assert.ok(blocks.some((b) => b.type === 'section' && b.text.text === 'Task created: link'));
    const context = blocks.find((b) => b.type === 'context');
    assert.ok(context.elements[0].text.includes('<@U2>'));
  });

  it('renders rejected outcome', () => {
    const blocks = buildResolvedCard(taskProposal(), { outcome: 'rejected', actorId: 'U2' });
    assert.ok(blocks[0].text.text.includes('Rejected'));
  });

  it('renders failed outcome', () => {
    const blocks = buildResolvedCard(taskProposal(), { outcome: 'failed', actorId: 'U2', detail: ':warning: boom' });
    assert.ok(blocks[0].text.text.includes('execution failed'));
  });
});
