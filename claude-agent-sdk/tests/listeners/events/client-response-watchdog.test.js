import assert from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

// Hermetic: use the test fixture, never the real checked-in conventions.
const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/conventions.json', import.meta.url));
process.env.CONVENTIONS_PATH = FIXTURE_PATH;

import { resetConventionsCache } from '../../../config/index.js';
import { resetResolverCache } from '../../../config/resolver.js';
import {
  handleClientResponseAck,
  handleClientResponseWatchdog as handleClientResponseWatchdogImpl,
  resetClientResponseWatchdogState,
} from '../../../listeners/events/client-response-watchdog.js';
import { pendingClientMessages } from '../../../thread-context/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'response-watchdog-'));

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.env.CONVENTIONS_PATH = FIXTURE_PATH;
  resetConventionsCache();
});

// From the fixture.
const EXTERNAL_CHANNEL = 'C0000000000'; // example-client, has an internal_channel_id
const NO_INTERNAL_EXTERNAL_CHANNEL = 'C0EXTERNAL9'; // no-internal, no internal_channel_id
const LEAD_ID = 'U0000000LEAD';
const MEMBER_ID = 'U000000MEMBR';
const CLIENT_USER_ID = 'U0SOMECLIENT';

function makeClient(channelName = 'general') {
  return {
    conversations: {
      info: mock.fn(async ({ channel }) => ({ channel: { id: channel, name: channelName } })),
    },
  };
}

function makeLogger() {
  return { info: mock.fn(), error: mock.fn() };
}

function makeEvent(overrides = {}) {
  return { channel: EXTERNAL_CHANNEL, ts: '1.0', user: CLIENT_USER_ID, text: 'hi, any update?', ...overrides };
}

function handleClientResponseWatchdog(args) {
  return handleClientResponseWatchdogImpl({
    ...args,
    classifyMessage: args.classifyMessage || (async () => 'QUESTION'),
  });
}

describe('handleClientResponseWatchdog', () => {
  beforeEach(() => {
    resetConventionsCache();
    resetResolverCache();
    resetClientResponseWatchdogState();
    pendingClientMessages.clear();
  });

  it('records a pending entry for a client message in a registered external channel', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent(), logger: makeLogger() });
    const entry = pendingClientMessages.get(EXTERNAL_CHANNEL);
    assert.strictEqual(entry?.clientKey, 'example-client');
    assert.strictEqual(entry?.snippet, 'hi, any update?');
  });

  it('ignores acknowledgements, praise, and link shares that Claude says need no response', async () => {
    const client = makeClient();
    const messages = [
      'These are beautiful- thank you so much <@U123>!',
      '<@U123> here you go: <https://www.figma.com/design/example>',
      'Thanks!',
      'Okay, got it',
    ];

    for (const [index, text] of messages.entries()) {
      const classifyMessage = mock.fn(async () => 'NO_RESPONSE_NEEDED');
      await handleClientResponseWatchdog({
        client,
        event: makeEvent({ ts: `${index + 2}.0`, text }),
        logger: makeLogger(),
        classifyMessage,
      });
      assert.strictEqual(classifyMessage.mock.callCount(), 1);
      assert.strictEqual(classifyMessage.mock.calls[0].arguments[0].text, text);
      assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
    }
  });

  it('tracks every Claude category that clearly requires a response', async () => {
    const client = makeClient();
    const categories = ['REQUEST', 'QUESTION', 'FOLLOW_UP', 'ACTIONABLE_FEEDBACK'];

    for (const [index, category] of categories.entries()) {
      await handleClientResponseWatchdog({
        client,
        event: makeEvent({ ts: `${index + 2}.0` }),
        logger: makeLogger(),
        classifyMessage: async () => category,
      });
      assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
      pendingClientMessages.clear();
    }
  });

  it('keeps an existing real ask when a later acknowledgement needs no response', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '1.0', text: 'Can you send the updated homepage today?' }),
      logger: makeLogger(),
      classifyMessage: async () => 'REQUEST',
    });
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '2.0', text: 'Thanks!' }),
      logger: makeLogger(),
      classifyMessage: async () => 'NO_RESPONSE_NEEDED',
    });

    const entry = pendingClientMessages.get(EXTERNAL_CHANNEL);
    assert.strictEqual(entry?.firstMessageTs, '1.0');
    assert.strictEqual(entry?.latestMessageTs, '1.0');
    assert.strictEqual(entry?.snippet, 'Can you send the updated homepage today?');
  });

  it('fails closed when Claude classification fails', async () => {
    const client = makeClient();
    const logger = makeLogger();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent(),
      logger,
      classifyMessage: async () => {
        throw new Error('API unavailable');
      },
    });

    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
    assert.strictEqual(logger.error.mock.callCount(), 1);
    assert.match(logger.error.mock.calls[0].arguments[0], /API unavailable/);
  });

  it('does not recreate a pending entry when a team reply lands during classification', async () => {
    const client = makeClient();
    /** @type {(category: string) => void} */
    let finishClassification;
    const classification = new Promise((resolve) => {
      finishClassification = resolve;
    });
    const clientHandling = handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '1.0' }),
      logger: makeLogger(),
      classifyMessage: async () => classification,
    });

    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '2.0', user: MEMBER_ID, text: 'On it' }),
      logger: makeLogger(),
    });
    finishClassification('QUESTION');
    await clientHandling;

    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('does not create a pending entry when a team acknowledgement lands during classification', async () => {
    const client = makeClient();
    /** @type {(category: string) => void} */
    let finishClassification;
    const classification = new Promise((resolve) => {
      finishClassification = resolve;
    });
    const clientHandling = handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '1.0' }),
      logger: makeLogger(),
      classifyMessage: async () => classification,
    });

    await handleClientResponseAck({ client, event: makeReactionEvent(), logger: makeLogger() });
    finishClassification('QUESTION');
    await clientHandling;

    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('does not treat an acknowledgement on another message as a reply to an in-flight ask', async () => {
    const client = makeClient();
    /** @type {(category: string) => void} */
    let finishClassification;
    const classification = new Promise((resolve) => {
      finishClassification = resolve;
    });
    const clientHandling = handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '1.0' }),
      logger: makeLogger(),
      classifyMessage: async () => classification,
    });

    await handleClientResponseAck({
      client,
      event: makeReactionEvent({ item: { type: 'message', channel: EXTERNAL_CHANNEL, ts: '2.0' } }),
      logger: makeLogger(),
    });
    finishClassification('QUESTION');
    await clientHandling;

    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
  });

  it('clears a pending entry when a team member posts afterward', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent(), logger: makeLogger() });
    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));

    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ user: MEMBER_ID, text: 'on it!' }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('a lead reply also clears the pending entry', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent(), logger: makeLogger() });
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ user: LEAD_ID, text: 'looking now' }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('does not track a client channel with no internal_channel_id configured', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ channel: NO_INTERNAL_EXTERNAL_CHANNEL }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get(NO_INTERNAL_EXTERNAL_CHANNEL), undefined);
  });

  it('ignores a channel that is not client-external', async () => {
    const client = makeClient('team-internal-chat');
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ channel: 'C0SOMEOTHER1' }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get('C0SOMEOTHER1'), undefined);
  });

  it('ignores bot messages', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ bot_id: 'B0BOT', user: undefined }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('ignores non-processable subtypes like message_changed', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ subtype: 'message_changed' }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('keeps the firstMessageTs when the client sends a second message before any reply', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '1.0', text: 'first' }),
      logger: makeLogger(),
    });
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '2.0', text: 'second' }),
      logger: makeLogger(),
    });
    const entry = pendingClientMessages.get(EXTERNAL_CHANNEL);
    assert.strictEqual(entry?.firstMessageTs, '1.0');
    assert.strictEqual(entry?.latestMessageTs, '2.0');
    assert.strictEqual(entry?.snippet, 'second');
  });

  it('does nothing when the watchdog is disabled in config', async () => {
    const tempPath = join(tempDir, 'disabled.json');
    copyFileSync(FIXTURE_PATH, tempPath);
    const data = JSON.parse(readFileSync(tempPath, 'utf8'));
    data.client_response_watchdog.enabled = false;
    writeFileSync(tempPath, JSON.stringify(data));
    process.env.CONVENTIONS_PATH = tempPath;
    resetConventionsCache();
    try {
      const client = makeClient();
      await handleClientResponseWatchdog({ client, event: makeEvent(), logger: makeLogger() });
      assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
    } finally {
      process.env.CONVENTIONS_PATH = FIXTURE_PATH;
      resetConventionsCache();
    }
  });
});

function makeReactionEvent(overrides = {}) {
  return {
    user: MEMBER_ID,
    reaction: 'thumbsup',
    item: { type: 'message', channel: EXTERNAL_CHANNEL, ts: '1.0' },
    ...overrides,
  };
}

describe('handleClientResponseAck', () => {
  beforeEach(() => {
    resetConventionsCache();
    resetResolverCache();
    resetClientResponseWatchdogState();
    pendingClientMessages.clear();
  });

  it('clears the pending entry when a team member reacts with a thumbs-up on the tracked message', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });
    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));

    await handleClientResponseAck({ client, event: makeReactionEvent(), logger: makeLogger() });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('clears the pending entry on a check-mark reaction on the latest tracked message', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '1.0', text: 'first' }),
      logger: makeLogger(),
    });
    await handleClientResponseWatchdog({
      client,
      event: makeEvent({ ts: '2.0', text: 'second' }),
      logger: makeLogger(),
    });

    await handleClientResponseAck({
      client,
      event: makeReactionEvent({
        reaction: 'white_check_mark',
        item: { type: 'message', channel: EXTERNAL_CHANNEL, ts: '2.0' },
      }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('a lead reacting also clears the pending entry', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });
    await handleClientResponseAck({ client, event: makeReactionEvent({ user: LEAD_ID }), logger: makeLogger() });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('ignores a reaction from someone not in conventions.users (e.g. the client themself)', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });
    await handleClientResponseAck({
      client,
      event: makeReactionEvent({ user: CLIENT_USER_ID }),
      logger: makeLogger(),
    });
    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
  });

  it('ignores a reaction emoji that is not in the ack set', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });
    await handleClientResponseAck({
      client,
      event: makeReactionEvent({ reaction: 'eyes' }),
      logger: makeLogger(),
    });
    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
  });

  it('ignores a reaction on a message that is not the tracked one', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });
    await handleClientResponseAck({
      client,
      event: makeReactionEvent({ item: { type: 'message', channel: EXTERNAL_CHANNEL, ts: '9.9' } }),
      logger: makeLogger(),
    });
    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
  });

  it('does nothing when there is no pending entry for the channel', async () => {
    const client = makeClient();
    await handleClientResponseAck({ client, event: makeReactionEvent(), logger: makeLogger() });
    assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
  });

  it('ignores a reaction on a channel that is not client-external', async () => {
    const client = makeClient('team-internal-chat');
    await handleClientResponseAck({
      client,
      event: makeReactionEvent({ item: { type: 'message', channel: 'C0SOMEOTHER1', ts: '1.0' } }),
      logger: makeLogger(),
    });
    assert.strictEqual(pendingClientMessages.get('C0SOMEOTHER1'), undefined);
  });

  it('ignores non-message reaction targets (e.g. a file)', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });
    await handleClientResponseAck({
      client,
      event: makeReactionEvent({ item: { type: 'file', file: 'F123' } }),
      logger: makeLogger(),
    });
    assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
  });

  it('does nothing when the watchdog is disabled in config', async () => {
    const tempPath = join(tempDir, 'ack-disabled.json');
    copyFileSync(FIXTURE_PATH, tempPath);
    const data = JSON.parse(readFileSync(tempPath, 'utf8'));
    data.client_response_watchdog.enabled = false;
    writeFileSync(tempPath, JSON.stringify(data));
    process.env.CONVENTIONS_PATH = tempPath;
    resetConventionsCache();
    try {
      const client = makeClient();
      pendingClientMessages.recordClientMessage(EXTERNAL_CHANNEL, {
        clientKey: 'example-client',
        messageTs: '1.0',
        snippet: 'hi',
      });
      await handleClientResponseAck({ client, event: makeReactionEvent(), logger: makeLogger() });
      assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));
    } finally {
      process.env.CONVENTIONS_PATH = FIXTURE_PATH;
      resetConventionsCache();
    }
  });

  it('honors a custom ack_emoji list from config', async () => {
    const tempPath = join(tempDir, 'custom-ack.json');
    copyFileSync(FIXTURE_PATH, tempPath);
    const data = JSON.parse(readFileSync(tempPath, 'utf8'));
    data.client_response_watchdog.ack_emoji = ['eyes'];
    writeFileSync(tempPath, JSON.stringify(data));
    process.env.CONVENTIONS_PATH = tempPath;
    resetConventionsCache();
    try {
      const client = makeClient();
      await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0' }), logger: makeLogger() });

      // Default thumbsup no longer counts once the list is overridden.
      await handleClientResponseAck({ client, event: makeReactionEvent(), logger: makeLogger() });
      assert.ok(pendingClientMessages.get(EXTERNAL_CHANNEL));

      await handleClientResponseAck({
        client,
        event: makeReactionEvent({ reaction: 'eyes' }),
        logger: makeLogger(),
      });
      assert.strictEqual(pendingClientMessages.get(EXTERNAL_CHANNEL), undefined);
    } finally {
      process.env.CONVENTIONS_PATH = FIXTURE_PATH;
      resetConventionsCache();
    }
  });
});
