import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resetResolverCache } from '../../../config/resolver.js';
import { handleAppMentioned } from '../../../listeners/events/app-mentioned.js';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = fileURLToPath(new URL('../../fixtures/conventions.json', import.meta.url));

// From the fixture: C0000000000 is a client channel, C0INTERNAL0 an internal one.
const CLIENT_CHANNEL = 'C0000000000';
const INTERNAL_CHANNEL = 'C0INTERNAL0';
const UNMAPPED_CHANNEL = 'C0RANDOM000';
/** Not in config at all — only its NAME says it is client-facing. */
const UNMAPPED_CLIENT_CHANNEL = 'C0NEWCLIENT';

/** @type {Record<string, string>} Channel names Slack would report. */
const CHANNEL_NAMES = {
  [UNMAPPED_CHANNEL]: 'random-internal-chat',
  [UNMAPPED_CLIENT_CHANNEL]: 'brandnew-pixelup',
};

describe('handleAppMentioned default-deny', () => {
  let fakeClient;
  let fakeContext;
  let fakeLogger;
  let fakeSay;
  let fakeSetStatus;

  beforeEach(() => {
    resetResolverCache();
    fakeClient = {
      reactions: { add: mock.fn(async () => ({ ok: true })) },
      conversations: {
        info: mock.fn(async (/** @type {any} */ { channel }) => {
          const name = CHANNEL_NAMES[channel];
          if (!name) throw new Error('channel_not_found');
          return { ok: true, channel: { name } };
        }),
      },
    };
    fakeContext = { userId: 'U0000000LEAD' };
    fakeLogger = { info: mock.fn(), error: mock.fn() };
    fakeSay = mock.fn(async () => ({ ok: true }));
    fakeSetStatus = mock.fn(async () => {});
  });

  /** @param {string} channel @param {string} text */
  function event(channel, text) {
    return { channel, text, ts: '1.0' };
  }

  it('stays silent when mentioned in a client channel', async () => {
    await handleAppMentioned({
      client: fakeClient,
      context: fakeContext,
      event: event(CLIENT_CHANNEL, '<@U0BOT> hello'),
      logger: fakeLogger,
      say: fakeSay,
      sayStream: mock.fn(),
      setStatus: fakeSetStatus,
    });
    assert.strictEqual(fakeSay.mock.callCount(), 0);
    assert.strictEqual(fakeClient.reactions.add.mock.callCount(), 0);
    assert.strictEqual(fakeLogger.info.mock.callCount(), 1);
  });

  it('responds in unmapped channels it has been invited to (empty mention → greeting)', async () => {
    await handleAppMentioned({
      client: fakeClient,
      context: fakeContext,
      event: event(UNMAPPED_CHANNEL, '<@U0BOT>'),
      logger: fakeLogger,
      say: fakeSay,
      sayStream: mock.fn(),
      setStatus: fakeSetStatus,
    });
    assert.strictEqual(fakeSay.mock.callCount(), 1);
  });

  it('stays silent in a client channel that config has never heard of', async () => {
    // The whole point of name-based resolution: a brand-new `{client}-pixelup`
    // channel is client-facing before anyone edits conventions.json.
    await handleAppMentioned({
      client: fakeClient,
      context: fakeContext,
      event: event(UNMAPPED_CLIENT_CHANNEL, '<@U0BOT> hello'),
      logger: fakeLogger,
      say: fakeSay,
      sayStream: mock.fn(),
      setStatus: fakeSetStatus,
    });
    assert.strictEqual(fakeSay.mock.callCount(), 0);
    assert.strictEqual(fakeClient.reactions.add.mock.callCount(), 0);
  });

  it('stays silent when the channel cannot be identified (fail-closed)', async () => {
    // Slack lookup fails → we cannot prove this is internal → say nothing.
    // Silence is recoverable; a message in front of a client is not.
    await handleAppMentioned({
      client: fakeClient,
      context: fakeContext,
      event: event('C0UNKNOWN00', '<@U0BOT> hello'),
      logger: fakeLogger,
      say: fakeSay,
      sayStream: mock.fn(),
      setStatus: fakeSetStatus,
    });
    assert.strictEqual(fakeSay.mock.callCount(), 0);
  });

  it('responds in configured internal channels (empty mention → greeting)', async () => {
    await handleAppMentioned({
      client: fakeClient,
      context: fakeContext,
      event: event(INTERNAL_CHANNEL, '<@U0BOT>'),
      logger: fakeLogger,
      say: fakeSay,
      sayStream: mock.fn(),
      setStatus: fakeSetStatus,
    });
    assert.strictEqual(fakeSay.mock.callCount(), 1);
  });
});
