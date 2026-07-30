import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import {
  compactMessages,
  fetchChannelHistory,
  fetchThreadReplies,
  lookupChannelIdByName,
  resetChannelCache,
  resolveChannelArg,
} from '../../../agent/tools/slack-read.js';

/** @returns {any} Minimal conventions shape for channel resolution. */
function conventions() {
  return {
    clients: {
      acme: { display_name: 'Acme', channel_id: 'C0ACME', internal_channel_id: 'C0ACMEINT' },
      ghost: { display_name: 'Ghost', channel_id: 'C_TODO_GHOST' },
    },
  };
}

describe('resolveChannelArg', () => {
  it('resolves a client key to the external channel ID', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'acme'), { id: 'C0ACME' });
  });

  it('resolves "{key}-internal" to the internal channel ID', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'acme-internal'), { id: 'C0ACMEINT' });
  });

  it('passes raw channel IDs through untouched', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'C0OTHER'), { id: 'C0OTHER' });
  });

  it('falls back to a live name lookup for placeholder channel IDs', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'ghost'), { lookupName: 'ghost-pixelup' });
  });

  it('falls back to a live name lookup when the internal channel is not configured', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'ghost-internal'), { lookupName: 'ghost-internal' });
  });

  it('treats unknown names as channel names to look up, stripping any leading #', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), '#design-team'), { lookupName: 'design-team' });
  });
});

describe('fetchChannelHistory', () => {
  /**
   * Slack-shaped history fake: serves `total` messages in pages of 200, newest
   * first, exactly as conversations.history does.
   * @param {number} total
   */
  function pagedClient(total) {
    const all = Array.from({ length: total }, (_, i) => ({
      type: 'message',
      ts: String(2000 - i),
      user: 'U0CLIENT',
      text: `msg ${total - i}`,
    }));
    return {
      calls: /** @type {any[]} */ ([]),
      conversations: {
        history: mock.fn(async (/** @type {any} */ args) => {
          const start = args.cursor ? Number(args.cursor) : 0;
          const size = Math.min(args.limit || 200, 200);
          const page = all.slice(start, start + size);
          const next = start + size;
          return {
            messages: page,
            has_more: next < all.length,
            response_metadata: next < all.length ? { next_cursor: String(next) } : {},
          };
        }),
      },
    };
  }

  it('paginates past the single-page limit to reach the whole channel', async () => {
    const client = pagedClient(475);
    const { messages, hasMore } = await fetchChannelHistory(/** @type {any} */ (client), 'C1', { limit: 5000 });
    assert.strictEqual(messages.length, 475);
    assert.strictEqual(hasMore, false);
    assert.ok(client.conversations.history.mock.callCount() >= 3);
  });

  it('reports messages left unread when the request bounded the read', async () => {
    const client = pagedClient(1000);
    const { messages, hasMore } = await fetchChannelHistory(/** @type {any} */ (client), 'C1', { limit: 50 });
    assert.strictEqual(messages.length, 50);
    assert.strictEqual(hasMore, true);
  });

  it('reads far more than the old 30-message cap when asked', async () => {
    const client = pagedClient(1000);
    const { messages } = await fetchChannelHistory(/** @type {any} */ (client), 'C1', { limit: 600 });
    assert.strictEqual(messages.length, 600);
  });

  it('defaults to a small recent read in a single request', async () => {
    const client = pagedClient(1000);
    const { messages } = await fetchChannelHistory(/** @type {any} */ (client), 'C1');
    assert.strictEqual(messages.length, 15);
    assert.strictEqual(client.conversations.history.mock.callCount(), 1);
  });

  it('passes a date range through as Slack timestamps', async () => {
    const client = pagedClient(10);
    await fetchChannelHistory(/** @type {any} */ (client), 'C1', {
      limit: 100,
      sinceDate: '2026-07-01',
      untilDate: '2026-07-31',
    });
    const args = client.conversations.history.mock.calls[0].arguments[0];
    assert.strictEqual(args.oldest, String(Math.floor(Date.parse('2026-07-01') / 1000)));
    assert.strictEqual(args.latest, String(Math.floor(Date.parse('2026-07-31') / 1000)));
  });
});

describe('fetchThreadReplies', () => {
  it('paginates a thread past one page of replies', async () => {
    let call = 0;
    const client = {
      conversations: {
        replies: mock.fn(async () => {
          call += 1;
          return {
            messages: Array.from({ length: 200 }, (_, i) => ({ type: 'message', ts: `${call}.${i}`, text: 'x' })),
            has_more: call < 2,
            response_metadata: call < 2 ? { next_cursor: 'c2' } : {},
          };
        }),
      },
    };
    const messages = await fetchThreadReplies(/** @type {any} */ (client), 'C1', '1.0');
    assert.strictEqual(messages.length, 400);
  });
});

describe('compactMessages', () => {
  it('renders oldest → newest regardless of the order Slack returned', () => {
    const text = compactMessages([
      { type: 'message', ts: '300', user: 'U1', text: 'third' },
      { type: 'message', ts: '100', user: 'U1', text: 'first' },
      { type: 'message', ts: '200', user: 'U1', text: 'second' },
    ]);
    assert.deepStrictEqual(
      text.split('\n').map((l) => l.split(': ')[1]),
      ['first', 'second', 'third'],
    );
  });

  it('surfaces file permalinks and link-preview URLs the client shared', () => {
    const text = compactMessages([
      {
        type: 'message',
        ts: '100',
        user: 'U0CLIENT',
        text: 'new hero asset please, ref attached',
        files: [{ id: 'F1', name: 'hero-ref.png', permalink: 'https://slack.com/files/F1/hero-ref.png' }],
        attachments: [{ title: 'Dribbble shot', title_link: 'https://dribbble.com/shots/123' }],
      },
    ]);
    assert.ok(text.includes('hero-ref.png: https://slack.com/files/F1/hero-ref.png'));
    assert.ok(text.includes('(id: F1)'));
    assert.ok(text.includes('Dribbble shot: https://dribbble.com/shots/123'));
  });

  it('keeps a file-only message and notes threads worth opening', () => {
    const text = compactMessages([
      { type: 'message', ts: '100', user: 'U1', files: [{ id: 'F9', name: 'brief.pdf' }], reply_count: 3 },
    ]);
    assert.ok(text.includes('brief.pdf'));
    assert.ok(text.includes('3 replies'));
  });

  it('drops the oldest messages when over the size budget and says so', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      type: 'message',
      ts: String(100 + i),
      user: 'U1',
      text: 'x'.repeat(100),
    }));
    const text = compactMessages(messages, { maxChars: 1000 });
    assert.ok(text.startsWith('['));
    assert.ok(text.includes('older message(s) omitted'));
    assert.ok(text.includes('ts:149')); // newest survives
    assert.ok(!text.includes('ts:100')); // oldest dropped
  });
});

describe('lookupChannelIdByName', () => {
  beforeEach(() => resetChannelCache());

  /** @param {any[]} channels */
  function fakeClient(channels) {
    return {
      conversations: {
        list: mock.fn(async () => ({ channels, response_metadata: {} })),
      },
    };
  }

  it('finds a channel by name across the channels visible to the bot', async () => {
    const client = fakeClient([{ id: 'C0DESIGN', name: 'design-team' }]);
    const id = await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    assert.strictEqual(id, 'C0DESIGN');
  });

  it('serves repeat lookups from the cache without re-listing', async () => {
    const client = fakeClient([{ id: 'C0DESIGN', name: 'design-team' }]);
    await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    assert.strictEqual(client.conversations.list.mock.callCount(), 1);
  });

  it('does not re-list on a fresh cache miss (avoids hammering the API)', async () => {
    const client = fakeClient([{ id: 'C0DESIGN', name: 'design-team' }]);
    await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    const missing = await lookupChannelIdByName(/** @type {any} */ (client), 'no-such-channel');
    assert.strictEqual(missing, undefined);
    assert.strictEqual(client.conversations.list.mock.callCount(), 1);
  });
});
