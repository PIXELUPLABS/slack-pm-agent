import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = fileURLToPath(new URL('../fixtures/conventions.json', import.meta.url));

import { resetConventionsCache } from '../../config/index.js';
import {
  buildReminderText,
  checkPendingClientMessages,
  isDue,
} from '../../schedules/response-watchdog.js';
import { pendingClientMessages } from '../../thread-context/index.js';

const HOUR = 60 * 60 * 1000;

// From the fixture.
const EXTERNAL_CHANNEL = 'C0000000000'; // example-client → internal_channel_id C0INTERNAL0
const NO_INTERNAL_EXTERNAL_CHANNEL = 'C0EXTERNAL9'; // no-internal, no internal_channel_id

function makeClient({ permalink = 'https://slack.com/archives/x/p1' } = {}) {
  return {
    chat: {
      getPermalink: mock.fn(async () => ({ ok: true, permalink })),
      postMessage: mock.fn(async () => ({ ok: true })),
    },
  };
}

function makeLogger() {
  return { info: mock.fn(), error: mock.fn() };
}

describe('isDue', () => {
  it('is not due before the threshold has elapsed', () => {
    const now = Date.now();
    assert.strictEqual(isDue({ firstSeenAt: now - 7 * HOUR, lastAlertAt: 0 }, 8, now), false);
  });

  it('is due once the threshold has elapsed since first seen', () => {
    const now = Date.now();
    assert.strictEqual(isDue({ firstSeenAt: now - 8 * HOUR, lastAlertAt: 0 }, 8, now), true);
  });

  it('anchors on the last alert, not the first message, once one has fired', () => {
    const now = Date.now();
    // First seen 20h ago, but alerted only 2h ago — not due again yet.
    assert.strictEqual(isDue({ firstSeenAt: now - 20 * HOUR, lastAlertAt: now - 2 * HOUR }, 8, now), false);
    assert.strictEqual(isDue({ firstSeenAt: now - 20 * HOUR, lastAlertAt: now - 9 * HOUR }, 8, now), true);
  });
});

describe('buildReminderText', () => {
  it('includes the display name, wait time, channel mention, snippet, and permalink', () => {
    const now = Date.now();
    const text = buildReminderText({
      entry: { firstSeenAt: now - 8 * HOUR, alertCount: 0, snippet: 'any update on the logo?' },
      channelId: 'C0000000000',
      displayName: 'Example Client',
      permalink: 'https://slack.com/archives/x/p1',
      now,
    });
    assert.match(text, /Example Client/);
    assert.match(text, /8h/);
    assert.match(text, /<#C0000000000>/);
    assert.match(text, /any update on the logo\?/);
    assert.match(text, /Jump to message/);
    assert.match(text, /No reply yet/);
  });

  it('says "Still no reply" once at least one reminder has already fired', () => {
    const text = buildReminderText({
      entry: { firstSeenAt: Date.now() - 16 * HOUR, alertCount: 1, snippet: '' },
      channelId: 'C0000000000',
      displayName: 'Example Client',
      permalink: '',
    });
    assert.match(text, /Still no reply/);
    assert.doesNotMatch(text, /Jump to message/);
  });
});

describe('checkPendingClientMessages', () => {
  beforeEach(() => {
    resetConventionsCache();
    pendingClientMessages.clear();
  });

  it('posts a reminder to the internal channel once the threshold has elapsed', async () => {
    pendingClientMessages.recordClientMessage(EXTERNAL_CHANNEL, {
      clientKey: 'example-client',
      messageTs: '1.0',
      snippet: 'still waiting on this',
    });
    const entry = pendingClientMessages.get(EXTERNAL_CHANNEL);
    entry.firstSeenAt = Date.now() - 9 * HOUR;

    const client = makeClient();
    await checkPendingClientMessages(client, makeLogger());

    assert.strictEqual(client.chat.postMessage.mock.calls.length, 1);
    const call = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(call.channel, 'C0INTERNAL0');
    assert.match(call.text, /Example Client/);
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL)?.alertCount, 1);
  });

  it('does not post before the threshold has elapsed', async () => {
    pendingClientMessages.recordClientMessage(EXTERNAL_CHANNEL, {
      clientKey: 'example-client',
      messageTs: '1.0',
      snippet: 'hi',
    });
    const client = makeClient();
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 0);
  });

  it('fires again after another full threshold if still unanswered', async () => {
    pendingClientMessages.recordClientMessage(EXTERNAL_CHANNEL, {
      clientKey: 'example-client',
      messageTs: '1.0',
      snippet: 'hi',
    });
    const entry = pendingClientMessages.get(EXTERNAL_CHANNEL);
    entry.firstSeenAt = Date.now() - 9 * HOUR;

    const client = makeClient();
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 1);

    // Not due again immediately after the first alert.
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 1);

    // Push the last alert back another full threshold — due again.
    entry.lastAlertAt = Date.now() - 8 * HOUR;
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 2);
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL)?.alertCount, 2);
  });

  it('stops once a team member reply has cleared the pending entry', async () => {
    pendingClientMessages.recordClientMessage(EXTERNAL_CHANNEL, {
      clientKey: 'example-client',
      messageTs: '1.0',
      snippet: 'hi',
    });
    pendingClientMessages.get(EXTERNAL_CHANNEL).firstSeenAt = Date.now() - 9 * HOUR;
    pendingClientMessages.clearChannel(EXTERNAL_CHANNEL);

    const client = makeClient();
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 0);
  });

  it('drops a pending entry whose client has no configured internal_channel_id, without posting', async () => {
    pendingClientMessages.recordClientMessage(NO_INTERNAL_EXTERNAL_CHANNEL, {
      clientKey: 'no-internal',
      messageTs: '1.0',
      snippet: 'hi',
    });
    pendingClientMessages.get(NO_INTERNAL_EXTERNAL_CHANNEL).firstSeenAt = Date.now() - 9 * HOUR;

    const client = makeClient();
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 0);
    assert.strictEqual(pendingClientMessages.get(NO_INTERNAL_EXTERNAL_CHANNEL), undefined);
  });

  it('still posts when the permalink lookup fails', async () => {
    pendingClientMessages.recordClientMessage(EXTERNAL_CHANNEL, {
      clientKey: 'example-client',
      messageTs: '1.0',
      snippet: 'hi',
    });
    pendingClientMessages.get(EXTERNAL_CHANNEL).firstSeenAt = Date.now() - 9 * HOUR;

    const client = makeClient();
    client.chat.getPermalink = mock.fn(async () => {
      throw new Error('no permalink scope');
    });
    await checkPendingClientMessages(client, makeLogger());
    assert.strictEqual(client.chat.postMessage.mock.calls.length, 1);
  });
});
