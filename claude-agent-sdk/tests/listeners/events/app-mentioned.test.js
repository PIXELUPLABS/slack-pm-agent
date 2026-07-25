import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { handleAppMentioned } from '../../../listeners/events/app-mentioned.js';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = new URL('../../fixtures/conventions.json', import.meta.url).pathname;

// From the fixture: C0000000000 is a client channel, C0INTERNAL0 an internal one.
const CLIENT_CHANNEL = 'C0000000000';
const INTERNAL_CHANNEL = 'C0INTERNAL0';
const UNMAPPED_CHANNEL = 'C0RANDOM000';

describe('handleAppMentioned default-deny', () => {
  let fakeClient;
  let fakeContext;
  let fakeLogger;
  let fakeSay;
  let fakeSetStatus;

  beforeEach(() => {
    fakeClient = { reactions: { add: mock.fn(async () => ({ ok: true })) } };
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
