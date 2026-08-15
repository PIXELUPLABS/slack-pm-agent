import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  categoryRequiresResponse,
  classifyClientMessage,
} from '../../../listeners/events/client-message-classifier.js';

function makeAnthropicClient(output, stopReason = 'end_turn') {
  return {
    messages: {
      create: mock.fn(async () => ({
        stop_reason: stopReason,
        content: output === null ? [] : [{ type: 'text', text: output }],
      })),
    },
  };
}

describe('classifyClientMessage', () => {
  it('returns a valid category from Claude and sends the message as delimited data', async () => {
    const client = makeAnthropicClient('FOLLOW_UP');
    const category = await classifyClientMessage(
      { text: 'Hi, following up on the homepage changes?', hasAttachments: true },
      { client },
    );

    assert.strictEqual(category, 'FOLLOW_UP');
    const request = client.messages.create.mock.calls[0].arguments[0];
    assert.strictEqual(request.model, 'claude-sonnet-5');
    assert.strictEqual(request.max_tokens, 20);
    assert.match(request.messages[0].content, /Has attachments: yes/);
    assert.match(request.messages[0].content, /<client_message>/);
    assert.match(request.messages[0].content, /following up on the homepage changes/);
  });

  it('normalizes surrounding whitespace and category casing', async () => {
    const client = makeAnthropicClient('  no_response_needed\n');
    assert.strictEqual(await classifyClientMessage({ text: 'Thanks!' }, { client }), 'NO_RESPONSE_NEEDED');
  });

  it('rejects an unexpected response instead of guessing', async () => {
    const client = makeAnthropicClient('MAYBE');
    await assert.rejects(() => classifyClientMessage({ text: 'Hello' }, { client }), /invalid.*category/i);
  });

  it('rejects a refusal', async () => {
    const client = makeAnthropicClient(null, 'refusal');
    await assert.rejects(() => classifyClientMessage({ text: 'Hello' }, { client }), /declined/);
  });
});

describe('categoryRequiresResponse', () => {
  it('only accepts the four categories with an obvious response obligation', () => {
    for (const category of ['REQUEST', 'QUESTION', 'FOLLOW_UP', 'ACTIONABLE_FEEDBACK']) {
      assert.strictEqual(categoryRequiresResponse(category), true);
    }
    assert.strictEqual(categoryRequiresResponse('NO_RESPONSE_NEEDED'), false);
  });
});
