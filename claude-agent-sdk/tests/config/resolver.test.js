import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { validateConventions } from '../../config/index.js';
import {
  canBotPostInChannel,
  classifyChannelName,
  discoverClients,
  isPlaceholderId,
  resetResolverCache,
  resolveChannelContext,
  resolveClientTargets,
} from '../../config/resolver.js';

/**
 * Deliberately mirrors the real config's worst case: a client whose channel IDs
 * were never filled in (`C_TODO_*`) and whose QA list is missing.
 */
function conventions() {
  return validateConventions({
    agency: { name: 'Pixelup Labs', voice: 'Direct.' },
    clickup: {
      task_name_format: '[{client}] {title}',
      priorities: { normal: 3 },
      default_priority: 'normal',
      statuses: ['to do'],
      default_status: 'to do',
    },
    clients: {
      acme: { display_name: 'Acme', channel_id: 'C0ACME', list_id: 'L1', qa_list_id: 'L2', folder_id: 'F1' },
      henrylabs: {
        display_name: 'HenryLabs',
        channel_id: 'C_TODO_HENRYLABS',
        list_id: 'L9',
        qa_list_id: '',
        folder_id: '',
      },
    },
    users: { U0LEAD: { name: 'Lead', clickup_user_id: 11, role: 'lead' } },
    channels: { drafts_channel_id: 'C0DRAFTS' },
    client_updates: { enabled: false, days: ['tuesday'], hour: 9, minute: 0, timezone: 'UTC' },
  });
}

/** @param {Record<string, string>} names channelId → name */
function slackWithNames(names) {
  return {
    conversations: {
      info: mock.fn(async (/** @type {any} */ { channel }) => {
        if (!names[channel]) throw new Error('channel_not_found');
        return { ok: true, channel: { name: names[channel] } };
      }),
      list: mock.fn(async () => ({
        channels: Object.entries(names).map(([id, name]) => ({ id, name })),
        response_metadata: {},
      })),
    },
  };
}

beforeEach(() => resetResolverCache());

describe('isPlaceholderId', () => {
  it('treats unfilled and empty IDs as absent', () => {
    assert.strictEqual(isPlaceholderId('C_TODO_HENRYLABS'), true);
    assert.strictEqual(isPlaceholderId(''), true);
    assert.strictEqual(isPlaceholderId(undefined), true);
    assert.strictEqual(isPlaceholderId('C0ACME'), false);
  });
});

describe('classifyChannelName', () => {
  it('reads the agency naming convention', () => {
    assert.deepStrictEqual(classifyChannelName('acme-pixelup'), { kind: 'client-external', clientKey: 'acme' });
    assert.deepStrictEqual(classifyChannelName('#Acme-Pixelup'), { kind: 'client-external', clientKey: 'acme' });
    assert.deepStrictEqual(classifyChannelName('acme-internal'), { kind: 'client-internal', clientKey: 'acme' });
    assert.deepStrictEqual(classifyChannelName('general'), { kind: 'other', clientKey: null });
  });
});

describe('resolveChannelContext', () => {
  it('prefers an explicit config mapping', async () => {
    const client = slackWithNames({});
    const ctx = await resolveChannelContext({ client, conventions: conventions(), channelId: 'C0ACME' });
    assert.deepStrictEqual(ctx, { kind: 'client-external', clientKey: 'acme', resolved: true });
    assert.strictEqual(client.conversations.info.mock.callCount(), 0); // no lookup needed
  });

  it('ignores placeholder config IDs and resolves by name instead', async () => {
    const client = slackWithNames({ C0HENRY: 'henrylabs-pixelup' });
    const ctx = await resolveChannelContext({ client, conventions: conventions(), channelId: 'C0HENRY' });
    assert.deepStrictEqual(ctx, { kind: 'client-external', clientKey: 'henrylabs', resolved: true });
  });

  it('identifies a client nobody has registered yet', async () => {
    const client = slackWithNames({ C0NEW: 'brandnew-pixelup' });
    const ctx = await resolveChannelContext({ client, conventions: conventions(), channelId: 'C0NEW' });
    assert.deepStrictEqual(ctx, { kind: 'client-external', clientKey: 'brandnew', resolved: true });
  });

  it('reports unresolved when Slack cannot name the channel', async () => {
    const ctx = await resolveChannelContext({
      client: slackWithNames({}),
      conventions: conventions(),
      channelId: 'C0MYSTERY',
    });
    assert.strictEqual(ctx.resolved, false);
  });

  it('memoizes the name lookup', async () => {
    const client = slackWithNames({ C0X: 'team-standup' });
    const conv = conventions();
    await resolveChannelContext({ client, conventions: conv, channelId: 'C0X' });
    await resolveChannelContext({ client, conventions: conv, channelId: 'C0X' });
    assert.strictEqual(client.conversations.info.mock.callCount(), 1);
  });

  it('does not memoize a failed lookup', async () => {
    const client = slackWithNames({});
    const conv = conventions();
    await resolveChannelContext({ client, conventions: conv, channelId: 'C0GONE' });
    await resolveChannelContext({ client, conventions: conv, channelId: 'C0GONE' });
    assert.strictEqual(client.conversations.info.mock.callCount(), 2);
  });
});

describe('canBotPostInChannel', () => {
  it('refuses a configured client channel', async () => {
    const res = await canBotPostInChannel({
      client: slackWithNames({}),
      conventions: conventions(),
      channelId: 'C0ACME',
    });
    assert.strictEqual(res.allowed, false);
  });

  it('refuses an unregistered client channel found by name', async () => {
    const res = await canBotPostInChannel({
      client: slackWithNames({ C0NEW: 'brandnew-pixelup' }),
      conventions: conventions(),
      channelId: 'C0NEW',
    });
    assert.strictEqual(res.allowed, false);
  });

  it('refuses a client channel whose config ID was never filled in', async () => {
    // The regression that mattered: a `C_TODO_*` entry used to read as "not a
    // client channel", so the bot would happily reply in front of the client.
    const res = await canBotPostInChannel({
      client: slackWithNames({ C0HENRY: 'henrylabs-pixelup' }),
      conventions: conventions(),
      channelId: 'C0HENRY',
    });
    assert.strictEqual(res.allowed, false);
  });

  it('fails closed when the channel cannot be identified', async () => {
    const res = await canBotPostInChannel({
      client: slackWithNames({}),
      conventions: conventions(),
      channelId: 'C0MYSTERY',
    });
    assert.strictEqual(res.allowed, false);
    assert.match(res.reason, /fail-closed/);
  });

  it('allows direct conversations on type alone (group DMs cannot be looked up)', async () => {
    const client = slackWithNames({});
    const conv = conventions();
    for (const channelType of ['im', 'mpim']) {
      const res = await canBotPostInChannel({ client, conventions: conv, channelId: 'D0X', channelType });
      assert.strictEqual(res.allowed, true, channelType);
    }
    assert.strictEqual(client.conversations.info.mock.callCount(), 0);
  });

  it('allows internal channels, including per-client internal ones', async () => {
    const client = slackWithNames({ C0INT: 'acme-internal', C0TEAM: 'design-team' });
    const conv = conventions();
    assert.strictEqual((await canBotPostInChannel({ client, conventions: conv, channelId: 'C0INT' })).allowed, true);
    assert.strictEqual((await canBotPostInChannel({ client, conventions: conv, channelId: 'C0TEAM' })).allowed, true);
  });
});

describe('resolveClientTargets', () => {
  const hierarchy = {
    children: [
      {
        type: 'space',
        name: 'Delivery',
        children: [
          {
            type: 'folder',
            id: 'F9',
            name: 'HenryLabs',
            children: [
              { type: 'list', id: 'L90', name: 'Website Engagement' },
              { type: 'list', id: 'L91', name: 'QA Board' },
            ],
          },
        ],
      },
    ],
  };

  it('uses config alone when it is complete — no ClickUp call', async () => {
    const clickup = { getHierarchy: mock.fn(async () => hierarchy) };
    const targets = await resolveClientTargets({ clientKey: 'acme', conventions: conventions(), clickup });
    assert.deepStrictEqual(targets, {
      listId: 'L1',
      qaListId: 'L2',
      folderId: 'F1',
      displayName: 'Acme',
      source: 'config',
    });
    assert.strictEqual(clickup.getHierarchy.mock.callCount(), 0);
  });

  it('fills the blanks from ClickUp while keeping config overrides', async () => {
    const clickup = { getHierarchy: mock.fn(async () => hierarchy) };
    const targets = await resolveClientTargets({ clientKey: 'henrylabs', conventions: conventions(), clickup });
    assert.strictEqual(targets?.listId, 'L9'); // config override wins
    assert.strictEqual(targets?.qaListId, 'L91'); // discovered
    assert.strictEqual(targets?.folderId, 'F9'); // discovered
    assert.strictEqual(targets?.source, 'mixed');
  });

  it('memoizes discovery per client', async () => {
    const clickup = { getHierarchy: mock.fn(async () => hierarchy) };
    const conv = conventions();
    await resolveClientTargets({ clientKey: 'henrylabs', conventions: conv, clickup });
    await resolveClientTargets({ clientKey: 'henrylabs', conventions: conv, clickup });
    assert.strictEqual(clickup.getHierarchy.mock.callCount(), 1);
  });

  it('falls back to config when ClickUp is unreachable', async () => {
    const clickup = {
      getHierarchy: mock.fn(async () => {
        throw new Error('not authorized');
      }),
    };
    const targets = await resolveClientTargets({ clientKey: 'henrylabs', conventions: conventions(), clickup });
    assert.strictEqual(targets?.listId, 'L9');
    assert.strictEqual(targets?.qaListId, '');
  });

  it('returns null when there is no list anywhere', async () => {
    const conv = conventions();
    conv.clients.henrylabs.list_id = '';
    const targets = await resolveClientTargets({
      clientKey: 'henrylabs',
      conventions: conv,
      clickup: { getHierarchy: async () => ({ children: [] }) },
    });
    assert.strictEqual(targets, null);
  });
});

describe('discoverClients', () => {
  it('lists config clients plus unregistered ones found in Slack', async () => {
    const client = slackWithNames({
      C0ACME: 'acme-pixelup',
      C0ACMEINT: 'acme-internal',
      C0NEW: 'brandnew-pixelup',
      C0NOISE: 'general',
    });
    const found = await discoverClients({ client, conventions: conventions() });
    const byKey = Object.fromEntries(found.map((c) => [c.clientKey, c]));

    assert.strictEqual(byKey.acme.registered, true);
    assert.strictEqual(byKey.henrylabs.registered, true);
    assert.strictEqual(byKey.brandnew.registered, false);
    assert.strictEqual(byKey.brandnew.externalChannelId, 'C0NEW');
    assert.ok(!('general' in byKey));
  });

  it('back-fills the channel ID a placeholder config entry is missing', async () => {
    const client = slackWithNames({ C0HENRY: 'henrylabs-pixelup', C0HENRYINT: 'henrylabs-internal' });
    const found = await discoverClients({ client, conventions: conventions() });
    const henry = found.find((c) => c.clientKey === 'henrylabs');
    assert.strictEqual(henry?.externalChannelId, 'C0HENRY');
    assert.strictEqual(henry?.internalChannelId, 'C0HENRYINT');
  });
});
