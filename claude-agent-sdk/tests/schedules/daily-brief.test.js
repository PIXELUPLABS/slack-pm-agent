import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  buildDigest,
  deliverBrief,
  gatherChannelActivity,
  isSubstantiveMessage,
  lookbackHoursFor,
  runDailyBrief,
  selectInternalChannels,
  windowStart,
} from '../../schedules/daily-brief.js';

/** @param {Array<{ id: string, name: string, isMember?: boolean, isPrivate?: boolean }>} entries */
function workspaceOf(entries) {
  return new Map(
    entries.map((e) => [
      e.id,
      { id: e.id, name: e.name, isPrivate: e.isPrivate ?? false, isMember: e.isMember ?? true },
    ]),
  );
}

/** @param {any} overrides */
function conventionsOf(overrides = {}) {
  return {
    agency: { name: 'Pixelup Labs', voice: 'Direct.' },
    clients: {},
    channels: {},
    ...overrides,
  };
}

describe('isSubstantiveMessage', () => {
  it('keeps a normal message', () => {
    assert.strictEqual(isSubstantiveMessage({ type: 'message', text: 'ship it' }), true);
  });

  it('drops channel bookkeeping subtypes', () => {
    assert.strictEqual(isSubstantiveMessage({ type: 'message', subtype: 'channel_join', text: 'joined' }), false);
    assert.strictEqual(isSubstantiveMessage({ type: 'message', subtype: 'channel_topic', text: 'set topic' }), false);
  });

  it('keeps a message that is only a file or a reaction', () => {
    assert.strictEqual(isSubstantiveMessage({ type: 'message', files: [{ id: 'F1' }] }), true);
    assert.strictEqual(isSubstantiveMessage({ type: 'message', reactions: [{ name: 'eyes', count: 1 }] }), true);
  });

  it('drops non-messages and empty messages', () => {
    assert.strictEqual(isSubstantiveMessage({ type: 'file_comment', text: 'hi' }), false);
    assert.strictEqual(isSubstantiveMessage({ type: 'message', text: '' }), false);
    assert.strictEqual(isSubstantiveMessage(null), false);
  });
});

describe('selectInternalChannels', () => {
  it('picks up a client internal channel from config', () => {
    const workspace = workspaceOf([{ id: 'C1', name: 'acme-internal' }]);
    const conventions = conventionsOf({
      clients: { acme: { display_name: 'Acme', internal_channel_id: 'C1' } },
    });
    const { channels } = selectInternalChannels(workspace, conventions);
    assert.strictEqual(channels.length, 1);
    assert.strictEqual(channels[0].name, 'acme-internal');
    assert.strictEqual(channels[0].clientKey, 'acme');
    assert.strictEqual(channels[0].source, 'config-internal');
  });

  it("discovers a REGISTERED client's internal channel with no id in config", () => {
    const workspace = workspaceOf([{ id: 'C2', name: 'acme-internal' }]);
    const conventions = conventionsOf({ clients: { acme: { display_name: 'Acme' } } });
    const { channels } = selectInternalChannels(workspace, conventions);
    assert.strictEqual(channels.length, 1);
    assert.strictEqual(channels[0].source, 'discovered-internal');
    assert.strictEqual(channels[0].clientKey, 'acme');
  });

  it('SKIPS an *-internal channel whose key is not a registered client', () => {
    // #design-engineering-internal is a team channel, not a client project.
    const workspace = workspaceOf([{ id: 'C3', name: 'design-engineering-internal' }]);
    const { channels, skipped } = selectInternalChannels(workspace, conventionsOf());
    assert.deepStrictEqual(channels, []);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].name, 'design-engineering-internal');
    assert.match(skipped[0].reason, /not a registered client/);
  });

  it('sweeps a team channel named in daily_brief.internal_channels', () => {
    const workspace = workspaceOf([
      { id: 'C4', name: 'motion-design' },
      { id: 'C5', name: 'pixelup-website' },
      { id: 'C6', name: 'random-watercooler' },
    ]);
    const conventions = conventionsOf({
      daily_brief: { internal_channels: ['motion-design', 'pixelup-website'] },
    });
    const { channels } = selectInternalChannels(workspace, conventions);
    assert.deepStrictEqual(
      channels.map((c) => [c.name, c.source]),
      [
        ['motion-design', 'internal-allowlist'],
        ['pixelup-website', 'internal-allowlist'],
      ],
    );
  });

  it('allowlists an *-internal team channel that has no client behind it', () => {
    // #pixelup-internal matches the client naming convention but is a team channel;
    // the allowlist is what lets it in, and it must not be skipped.
    const workspace = workspaceOf([{ id: 'C7', name: 'pixelup-internal' }]);
    const conventions = conventionsOf({ daily_brief: { internal_channels: ['pixelup-internal'] } });
    const { channels, skipped } = selectInternalChannels(workspace, conventions);
    assert.strictEqual(channels.length, 1);
    assert.strictEqual(channels[0].source, 'internal-allowlist');
    assert.deepStrictEqual(skipped, []);
  });

  it('matches allowlist entries case-insensitively and ignores a leading #', () => {
    const workspace = workspaceOf([{ id: 'C8', name: 'motion-design' }]);
    const conventions = conventionsOf({ daily_brief: { internal_channels: ['#Motion-Design'] } });
    const { channels } = selectInternalChannels(workspace, conventions);
    assert.strictEqual(channels.length, 1);
  });

  it('sweeps nothing but registered clients when no allowlist is set', () => {
    const workspace = workspaceOf([
      { id: 'C1', name: 'acme-internal' },
      { id: 'C9', name: 'daily-updates' },
    ]);
    const conventions = conventionsOf({ clients: { acme: { display_name: 'Acme' } } });
    const { channels } = selectInternalChannels(workspace, conventions);
    assert.deepStrictEqual(
      channels.map((c) => c.name),
      ['acme-internal'],
    );
  });

  it('EXCLUDES a client-facing channel even when config names it', () => {
    const workspace = workspaceOf([{ id: 'C3', name: 'acme-pixelup' }]);
    const conventions = conventionsOf({
      clients: { acme: { display_name: 'Acme', internal_channel_id: 'C3' } },
    });
    const { channels, excluded } = selectInternalChannels(workspace, conventions);
    assert.deepStrictEqual(channels, []);
    assert.strictEqual(excluded.length, 1);
    assert.strictEqual(excluded[0].reason, 'client-facing channel');
  });

  it('never sweeps a client-facing channel that the allowlist names', () => {
    // Belt and braces: the allowlist must not be a way around the client guard.
    const workspace = workspaceOf([{ id: 'CX', name: 'acme-pixelup' }]);
    const conventions = conventionsOf({ daily_brief: { internal_channels: ['acme-pixelup'] } });
    const { channels, excluded } = selectInternalChannels(workspace, conventions);
    assert.deepStrictEqual(channels, []);
    assert.strictEqual(excluded.length, 1);
  });

  it('ignores placeholder and empty ids', () => {
    const workspace = workspaceOf([{ id: 'C1', name: 'acme-internal' }]);
    const conventions = conventionsOf({
      clients: {
        acme: { display_name: 'Acme', internal_channel_id: 'C_TODO_ACME' },
        beta: { display_name: 'Beta', internal_channel_id: '' },
      },
    });
    const { channels, missing } = selectInternalChannels(workspace, conventions);
    // acme-internal is still found by discovery, not by the placeholder.
    assert.strictEqual(channels.length, 1);
    assert.strictEqual(channels[0].source, 'discovered-internal');
    assert.deepStrictEqual(missing, []);
  });

  it('reports a configured channel the bot cannot see', () => {
    const conventions = conventionsOf({
      clients: { acme: { display_name: 'Acme', internal_channel_id: 'CGONE' } },
    });
    const { channels, missing } = selectInternalChannels(workspaceOf([]), conventions);
    assert.deepStrictEqual(channels, []);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].id, 'CGONE');
  });

  it('does not duplicate a channel found by config and by the allowlist', () => {
    const workspace = workspaceOf([{ id: 'C1', name: 'acme-internal' }]);
    const conventions = conventionsOf({
      clients: { acme: { display_name: 'Acme', internal_channel_id: 'C1' } },
      daily_brief: { internal_channels: ['acme-internal'] },
    });
    const { channels } = selectInternalChannels(workspace, conventions);
    assert.strictEqual(channels.length, 1);
    assert.strictEqual(channels[0].source, 'config-internal');
  });

  it('carries membership through so the brief can report what it missed', () => {
    const workspace = workspaceOf([{ id: 'C1', name: 'acme-internal' }]);
    const conventions = conventionsOf({ clients: { acme: { display_name: 'Acme' } } });
    const withoutBot = workspaceOf([{ id: 'C1', name: 'acme-internal', isMember: false }]);
    assert.strictEqual(selectInternalChannels(workspace, conventions).channels[0].isMember, true);
    assert.strictEqual(selectInternalChannels(withoutBot, conventions).channels[0].isMember, false);
  });
});

describe('lookbackHoursFor', () => {
  it('defaults to 24 hours', () => {
    assert.strictEqual(lookbackHoursFor('wednesday', {}), 24);
  });

  it('uses the configured window', () => {
    assert.strictEqual(lookbackHoursFor('wednesday', { lookback_hours: 12 }), 12);
  });

  it('reaches back over the weekend on Monday', () => {
    assert.strictEqual(lookbackHoursFor('monday', { lookback_hours: 24, monday_lookback_hours: 72 }), 72);
  });

  it('falls back to the normal window on Monday when no weekend window is set', () => {
    assert.strictEqual(lookbackHoursFor('monday', { lookback_hours: 24 }), 24);
  });
});

describe('windowStart', () => {
  it('subtracts the lookback from now', () => {
    assert.strictEqual(windowStart(new Date('2026-07-31T09:00:00Z'), 24), '2026-07-30T09:00:00.000Z');
  });
});

describe('gatherChannelActivity', () => {
  const SINCE = '2026-07-30T09:00:00Z';
  const UNTIL = '2026-07-31T09:00:00Z';
  const sinceSec = Math.floor(Date.parse(SINCE) / 1000);
  /** A ts inside the brief window. */
  const inWindow = (/** @type {number} */ minutes = 60) => String(sinceSec + minutes * 60);
  /** A ts before the brief window opened. */
  const older = (/** @type {number} */ hours = 48) => String(sinceSec - hours * 3600);

  /**
   * @param {Record<string, any[] | Error>} history Keyed by channel id.
   * @param {Record<string, any[]>} [threads] Keyed by parent ts.
   */
  const clientWith = (history, threads = {}) => ({
    conversations: {
      history: mock.fn(async (/** @type {any} */ { channel }) => {
        const messages = history[channel];
        if (messages instanceof Error) throw messages;
        return { messages: messages || [], has_more: false };
      }),
      replies: mock.fn(async (/** @type {any} */ { ts }) => ({ messages: threads[ts] || [], has_more: false })),
    },
  });

  const channel = (/** @type {any} */ o) => ({
    id: 'C1',
    name: 'acme-internal',
    clientKey: 'acme',
    isMember: true,
    source: /** @type {const} */ ('config-internal'),
    ...o,
  });

  it('returns active channels with a compacted digest', async () => {
    const client = clientWith({ C1: [{ type: 'message', user: 'U1', ts: inWindow(), text: 'ship it' }] });
    const { active, quiet } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].messageCount, 1);
    assert.match(active[0].text, /ship it/);
    assert.deepStrictEqual(quiet, []);
  });

  it('ignores messages older than the brief window', async () => {
    // The scan window is deliberately wider, so old messages ARE fetched — they
    // must not be briefed on unless a thread of theirs moved.
    const client = clientWith({ C1: [{ type: 'message', user: 'U1', ts: older(), text: 'last week' }] });
    const { active, quiet } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.deepStrictEqual(active, []);
    assert.strictEqual(quiet.length, 1);
  });

  it('drops a channel with nothing substantive in the window', async () => {
    const client = clientWith({
      C1: [{ type: 'message', subtype: 'channel_join', ts: inWindow(), text: 'joined' }],
    });
    const { active, quiet } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.deepStrictEqual(active, []);
    assert.strictEqual(quiet.length, 1);
  });

  it('never calls Slack for a channel the bot is not in', async () => {
    const client = clientWith({});
    const { unreadable } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({ isMember: false })],
      since: SINCE,
    });
    assert.strictEqual(client.conversations.history.mock.callCount(), 0);
    assert.strictEqual(unreadable.length, 1);
    assert.match(unreadable[0].error, /not_in_channel/);
  });

  it('records a Slack error instead of failing the whole run', async () => {
    const err = Object.assign(new Error('nope'), { data: { error: 'channel_not_found' } });
    const client = clientWith({
      C1: err,
      C2: [{ type: 'message', user: 'U1', ts: inWindow(), text: 'hi' }],
    });
    const { active, unreadable } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({}), channel({ id: 'C2', name: 'beta-internal', clientKey: 'beta' })],
      since: SINCE,
      until: UNTIL,
    });
    assert.strictEqual(unreadable[0].error, 'channel_not_found');
    assert.strictEqual(active.length, 1);
  });

  it('includes the in-thread ANSWER to a question asked in the window', async () => {
    const parentTs = inWindow(10);
    const client = clientWith(
      {
        C1: [
          {
            type: 'message',
            user: 'U1',
            ts: parentTs,
            text: 'can we ship?',
            reply_count: 1,
            latest_reply: inWindow(20),
          },
        ],
      },
      {
        [parentTs]: [
          { type: 'message', user: 'U1', ts: parentTs, text: 'can we ship?' },
          { type: 'message', user: 'U2', ts: inWindow(20), text: 'yes, approved' },
        ],
      },
    );
    const { active } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.strictEqual(active[0].threadsExpanded, 1);
    assert.strictEqual(active[0].messageCount, 2, 'question + answer');
    assert.match(active[0].text, /yes, approved/);
    // The reply is marked, so the digest cannot read it as a top-level message.
    assert.match(active[0].text, /↳ \[reply in thread on "can we ship\?"\]/);
  });

  it('finds replies on a thread whose parent predates the window', async () => {
    // A QA thread from last week that moved yesterday. conversations.history keys
    // off the parent ts, so without latest_reply detection this is invisible.
    const parentTs = older(72);
    const client = clientWith(
      {
        C1: [
          { type: 'message', user: 'U1', ts: parentTs, text: 'QA round 3', reply_count: 2, latest_reply: inWindow(30) },
        ],
      },
      {
        [parentTs]: [
          { type: 'message', user: 'U1', ts: parentTs, text: 'QA round 3' },
          { type: 'message', user: 'U2', ts: inWindow(30), text: 'all 12 bugs fixed' },
        ],
      },
    );
    const { active, quiet } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.deepStrictEqual(quiet, [], 'thread-only activity still counts as active');
    assert.strictEqual(active[0].messageCount, 1, 'the reply only — the old parent is not briefed');
    assert.match(active[0].text, /all 12 bugs fixed/);
    assert.match(active[0].text, /QA round 3/, 'parent carried as context on the reply');
    // The old parent must not appear as its own top-level line.
    assert.doesNotMatch(active[0].text, new RegExp(`\\[ts:${parentTs}\\] <@U1>: QA round 3`));
  });

  it('excludes replies that fall outside the window', async () => {
    const parentTs = older(72);
    const client = clientWith(
      {
        C1: [
          { type: 'message', user: 'U1', ts: parentTs, text: 'old thread', reply_count: 2, latest_reply: inWindow(30) },
        ],
      },
      {
        [parentTs]: [
          { type: 'message', user: 'U1', ts: parentTs, text: 'old thread' },
          { type: 'message', user: 'U2', ts: older(70), text: 'stale reply' },
          { type: 'message', user: 'U3', ts: inWindow(30), text: 'fresh reply' },
        ],
      },
    );
    const { active } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.match(active[0].text, /fresh reply/);
    assert.doesNotMatch(active[0].text, /stale reply/);
    assert.strictEqual(active[0].messageCount, 1);
  });

  it('does not expand a thread whose replies all predate the window', async () => {
    const parentTs = older(72);
    const client = clientWith(
      { C1: [{ type: 'message', user: 'U1', ts: parentTs, text: 'dormant', reply_count: 1, latest_reply: older(70) }] },
      { [parentTs]: [{ type: 'message', user: 'U1', ts: parentTs, text: 'dormant' }] },
    );
    const { active, quiet } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.strictEqual(client.conversations.replies.mock.callCount(), 0, 'no wasted API call');
    assert.deepStrictEqual(active, []);
    assert.strictEqual(quiet.length, 1);
  });

  it('caps threads per channel and says how many it skipped', async () => {
    /** @type {any[]} */
    const parents = [];
    /** @type {Record<string, any[]>} */
    const threads = {};
    for (let i = 0; i < 15; i++) {
      const ts = inWindow(i + 1);
      parents.push({ type: 'message', user: 'U1', ts, text: `q${i}`, reply_count: 1, latest_reply: inWindow(i + 2) });
      threads[ts] = [
        { type: 'message', user: 'U1', ts, text: `q${i}` },
        { type: 'message', user: 'U2', ts: inWindow(i + 2), text: `a${i}` },
      ];
    }
    const client = clientWith({ C1: parents }, threads);
    const { active } = await gatherChannelActivity({
      client: /** @type {any} */ (client),
      channels: [channel({})],
      since: SINCE,
      until: UNTIL,
    });
    assert.strictEqual(client.conversations.replies.mock.callCount(), 12, 'MAX_THREADS_PER_CHANNEL');
    assert.strictEqual(active[0].threadsExpanded, 12);
    assert.match(active[0].text, /3 more thread\(s\) in this channel had replies in the window but were not expanded/);
  });
});

describe('buildDigest', () => {
  const conventions = conventionsOf({ clients: { acme: { display_name: 'Acme Corp' } } });

  it('labels a channel with its client display name', () => {
    const { text, includedChannels } = buildDigest({
      active: [
        {
          id: 'C1',
          name: 'acme-internal',
          clientKey: 'acme',
          isMember: true,
          source: 'config-internal',
          messageCount: 2,
          text: 'lines',
        },
      ],
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.match(text, /#acme-internal \(client: Acme Corp\)/);
    assert.match(text, /Window: S → U/);
    assert.deepStrictEqual(includedChannels, ['#acme-internal']);
  });

  it('does not call an internal channel a client when no client owns it', () => {
    // #pixelup-internal matches the naming convention but there is no "pixelup" client.
    const { text } = buildDigest({
      active: [
        {
          id: 'C1',
          name: 'pixelup-internal',
          clientKey: 'pixelup',
          isMember: true,
          source: 'discovered-internal',
          messageCount: 3,
          text: 'lines',
        },
      ],
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.match(text, /=== #pixelup-internal — 3 message\(s\) ===/);
    assert.doesNotMatch(text, /client:/);
  });

  it('names silent projects so the brief can report "no update"', () => {
    const { text } = buildDigest({
      active: [
        {
          id: 'C1',
          name: 'acme-internal',
          clientKey: 'acme',
          isMember: true,
          source: 'config-internal',
          messageCount: 2,
          text: 'lines',
        },
      ],
      quiet: [
        {
          id: 'C2',
          name: 'sully-internal',
          clientKey: 'sully',
          isMember: true,
          source: 'discovered-internal',
        },
        { id: 'C3', name: 'random-internal', clientKey: null, isMember: true, source: 'discovered-internal' },
      ],
      conventions: /** @type {any} */ ({
        ...conventions,
        clients: { ...conventions.clients, sully: { display_name: 'Sully' } },
      }),
      since: 'S',
      until: 'U',
    });
    // Known client by display name, unknown one by channel, alphabetical.
    assert.match(text, /NO activity in the window[^\n]*: #random-internal, Sully/);
  });

  it('omits the no-activity line when every project was busy', () => {
    const { text } = buildDigest({
      active: [
        {
          id: 'C1',
          name: 'acme-internal',
          clientKey: 'acme',
          isMember: true,
          source: 'config-internal',
          messageCount: 2,
          text: 'lines',
        },
      ],
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.doesNotMatch(text, /NO activity/);
  });

  it('orders the busiest channel first', () => {
    const mk = (/** @type {string} */ name, /** @type {number} */ count) => ({
      id: name,
      name,
      clientKey: null,
      isMember: true,
      source: /** @type {const} */ ('discovered-internal'),
      messageCount: count,
      text: 'x',
    });
    const { includedChannels } = buildDigest({
      active: [mk('quiet-internal', 1), mk('busy-internal', 50)],
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.deepStrictEqual(includedChannels, ['#busy-internal', '#quiet-internal']);
  });

  it('drops channels over the total budget and says so', () => {
    const big = (/** @type {string} */ name, /** @type {number} */ count) => ({
      id: name,
      name,
      clientKey: null,
      isMember: true,
      source: /** @type {const} */ ('discovered-internal'),
      messageCount: count,
      text: 'x'.repeat(30000),
    });
    const { text, includedChannels, droppedChannels } = buildDigest({
      active: [big('a-internal', 10), big('b-internal', 5)],
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.deepStrictEqual(includedChannels, ['#a-internal']);
    assert.deepStrictEqual(droppedChannels, ['#b-internal']);
    assert.match(text, /omitted from this digest for size/);
  });
});

describe('deliverBrief', () => {
  it('posts to the DM conversation Slack opens', async () => {
    const client = {
      conversations: { open: mock.fn(async () => ({ channel: { id: 'D123' } })) },
      chat: { postMessage: mock.fn(async () => ({ ok: true })) },
    };
    const channel = await deliverBrief({
      client: /** @type {any} */ (client),
      recipientId: 'U1',
      text: 'brief',
    });
    assert.strictEqual(channel, 'D123');
    assert.strictEqual(client.chat.postMessage.mock.calls[0].arguments[0].channel, 'D123');
  });

  it('refuses to post when the conversation is not a DM', async () => {
    const client = {
      conversations: { open: mock.fn(async () => ({ channel: { id: 'C999' } })) },
      chat: { postMessage: mock.fn(async () => ({ ok: true })) },
    };
    await assert.rejects(
      () => deliverBrief({ client: /** @type {any} */ (client), recipientId: 'U1', text: 'brief' }),
      /not a DM conversation/,
    );
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('throws when the DM cannot be opened', async () => {
    const client = {
      conversations: { open: mock.fn(async () => ({})) },
      chat: { postMessage: mock.fn(async () => ({ ok: true })) },
    };
    await assert.rejects(
      () => deliverBrief({ client: /** @type {any} */ (client), recipientId: 'U1', text: 'brief' }),
      /Could not open a DM/,
    );
  });
});

describe('runDailyBrief', () => {
  /** A query() stand-in that yields one assistant text block. */
  const fakeQuery = (/** @type {string} */ text) =>
    async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    };

  /**
   * A ts inside the default 24h window. runDailyBrief derives its window from
   * the real clock, so fixtures have to be relative to now.
   */
  const recentTs = () => String(Math.floor(Date.now() / 1000) - 3600);

  /** @param {{ channels: any[], history: Record<string, any[]>, threads?: Record<string, any[]> }} args */
  const slackClient = ({ channels, history, threads = {} }) => ({
    conversations: {
      list: mock.fn(async () => ({ channels, response_metadata: {} })),
      history: mock.fn(async (/** @type {any} */ { channel }) => ({
        messages: history[channel] || [],
        has_more: false,
      })),
      replies: mock.fn(async (/** @type {any} */ { ts }) => ({ messages: threads[ts] || [], has_more: false })),
      open: mock.fn(async () => ({ channel: { id: 'D1' } })),
    },
    chat: { postMessage: mock.fn(async () => ({ ok: true })) },
  });

  const conventions = conventionsOf({
    clients: { acme: { display_name: 'Acme Corp', internal_channel_id: 'C1' } },
    daily_brief: { timezone: 'UTC', lookback_hours: 24 },
  });

  it('summarizes internal activity and DMs it', async () => {
    const client = slackClient({
      channels: [
        { id: 'C1', name: 'acme-internal', is_member: true },
        { id: 'C2', name: 'acme-pixelup', is_member: true },
      ],
      history: {
        C1: [{ type: 'message', user: 'U1', ts: recentTs(), text: 'logo v2 approved' }],
        C2: [{ type: 'message', user: 'U9', ts: recentTs(), text: 'client chatter' }],
      },
    });
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conventions),
      recipientId: 'U1',
      deliver: true,
      query: /** @type {any} */ (fakeQuery('*Decisions made*\n• Logo v2 approved')),
    });

    assert.strictEqual(result.deliveredTo, 'D1');
    assert.match(result.brief, /Logo v2 approved/);
    assert.deepStrictEqual(
      result.active.map((c) => c.name),
      ['#acme-internal'],
    );
    // The client-facing channel was never read.
    const readChannels = client.conversations.history.mock.calls.map((c) => c.arguments[0].channel);
    assert.deepStrictEqual(readChannels, ['C1']);
    // It is not in `excluded` either: no config source named it, so it was never
    // a candidate. `excluded` only reports channels config pointed at wrongly.
    assert.deepStrictEqual(result.excluded, []);
  });

  it('carries an in-thread answer through to the digest end to end', async () => {
    // The regression this guards: a question answered in a thread must not reach
    // the model looking unanswered, or the brief tells the founder they are
    // blocking work that already moved.
    const parentTs = recentTs();
    const replyTs = String(Number(parentTs) + 60);
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: {
        C1: [
          {
            type: 'message',
            user: 'U1',
            ts: parentTs,
            text: 'ok to send the mock to the client?',
            reply_count: 1,
            latest_reply: replyTs,
          },
        ],
      },
      threads: {
        [parentTs]: [
          { type: 'message', user: 'U1', ts: parentTs, text: 'ok to send the mock to the client?' },
          { type: 'message', user: 'U2', ts: replyTs, text: 'yes go ahead' },
        ],
      },
    });
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conventions),
      recipientId: 'U1',
      deliver: false,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.match(result.digest, /ok to send the mock to the client\?/);
    assert.match(result.digest, /yes go ahead/, 'the answer reached the prompt');
    assert.strictEqual(result.active[0].threadsExpanded, 1);
    assert.strictEqual(result.active[0].messageCount, 2);
  });

  it('sends a short no-activity note without calling the model', async () => {
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: { C1: [] },
    });
    const queryFn = mock.fn(fakeQuery('should not run'));
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conventions),
      recipientId: 'U1',
      deliver: true,
      query: /** @type {any} */ (queryFn),
    });
    assert.strictEqual(queryFn.mock.callCount(), 0);
    assert.match(result.brief, /no internal channel activity/);
    assert.strictEqual(result.deliveredTo, 'D1');
  });

  it('sends nothing when deliver is false', async () => {
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: { C1: [{ type: 'message', user: 'U1', ts: recentTs(), text: 'hi' }] },
    });
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conventions),
      recipientId: 'U1',
      deliver: false,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.strictEqual(result.deliveredTo, null);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('notes channels it could not read in the delivered brief', async () => {
    const client = slackClient({
      channels: [
        { id: 'C1', name: 'acme-internal', is_member: true },
        { id: 'C2', name: 'beta-internal', is_member: false },
      ],
      history: { C1: [{ type: 'message', user: 'U1', ts: recentTs(), text: 'hi' }] },
    });
    // beta must be a REGISTERED client, or it is skipped rather than reported
    // unreadable — only channels the brief means to sweep get the "invite me" note.
    const withBeta = {
      ...conventions,
      clients: { ...conventions.clients, beta: { display_name: 'Beta' } },
    };
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (withBeta),
      recipientId: 'U1',
      deliver: true,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.match(result.brief, /Couldn't read 1 channel\(s\): #beta-internal/);
  });

  it('skips an unregistered *-internal channel instead of nagging to be invited', async () => {
    const client = slackClient({
      channels: [
        { id: 'C1', name: 'acme-internal', is_member: true },
        { id: 'C2', name: 'design-engineering-internal', is_member: false },
      ],
      history: { C1: [{ type: 'message', user: 'U1', ts: recentTs(), text: 'hi' }] },
    });
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conventions),
      recipientId: 'U1',
      deliver: false,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.deepStrictEqual(result.unreadable, []);
    assert.deepStrictEqual(
      result.skipped.map((c) => c.name),
      ['#design-engineering-internal'],
    );
    assert.doesNotMatch(result.brief, /Couldn't read/);
  });
});
