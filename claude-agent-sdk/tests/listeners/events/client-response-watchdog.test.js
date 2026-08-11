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
import { handleClientResponseWatchdog } from '../../../listeners/events/client-response-watchdog.js';
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

describe('handleClientResponseWatchdog', () => {
  beforeEach(() => {
    resetConventionsCache();
    resetResolverCache();
    pendingClientMessages.clear();
  });

  it('records a pending entry for a client message in a registered external channel', async () => {
    const client = makeClient();
    await handleClientResponseWatchdog({ client, event: makeEvent(), logger: makeLogger() });
    const entry = pendingClientMessages.get(EXTERNAL_CHANNEL);
    assert.strictEqual(entry?.clientKey, 'example-client');
    assert.strictEqual(entry?.snippet, 'hi, any update?');
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
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '1.0', text: 'first' }), logger: makeLogger() });
    await handleClientResponseWatchdog({ client, event: makeEvent({ ts: '2.0', text: 'second' }), logger: makeLogger() });
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
