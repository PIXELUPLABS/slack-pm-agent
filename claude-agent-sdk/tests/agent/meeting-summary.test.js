import assert from 'node:assert';
import { describe, it } from 'node:test';

import { summarizeStandup } from '../../agent/meeting-summary.js';

describe('summarizeStandup', () => {
  it('uses a toolless, action-items-only standup prompt', async () => {
    let request;
    async function* query(input) {
      request = input;
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '*Daily standup — action items*\n• *Daksh:* Send copy.' }] },
      };
    }

    const result = await summarizeStandup(
      {
        title: 'Daily Standup | Pixel Up',
        headerText: 'Title: Daily Standup | Pixel Up',
        notesText: 'Action Items\nDaksh\nSend copy.',
      },
      { conventions: { agency: { voice: 'Direct.' } }, query },
    );

    assert.match(result, /Daily standup — action items/);
    assert.match(request.options.systemPrompt, /internal daily standup/);
    assert.match(request.options.systemPrompt, /Include only concrete next actions/);
    assert.deepStrictEqual(request.options.tools, []);
    assert.deepStrictEqual(request.options.allowedTools, []);
    assert.strictEqual(request.options.maxTurns, 1);
  });
});
