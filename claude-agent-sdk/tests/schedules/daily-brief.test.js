import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  buildDigest,
  buildWeeklyDigest,
  compactByDay,
  deliverBrief,
  findDirectMentions,
  gatherChannelActivity,
  isSubstantiveMessage,
  lookbackHoursFor,
  resolveMode,
  runDailyBrief,
  selectInternalChannels,
  summarizeChannels,
  windowHoursFor,
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
    users: { U1: { name: 'Arjun', clickup_user_id: 1, role: 'lead' } },
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

describe('resolveMode', () => {
  const weekly = { weekly_review: { enabled: true, day: 'monday' } };

  it('gives Monday the weekly review and the rest of the week the daily brief', () => {
    assert.strictEqual(resolveMode('monday', weekly), 'weekly');
    for (const day of ['tuesday', 'wednesday', 'thursday', 'friday']) {
      assert.strictEqual(resolveMode(day, weekly), 'daily');
    }
  });

  it('stays daily when weekly_review is absent, so old config is unchanged', () => {
    assert.strictEqual(resolveMode('monday', {}), 'daily');
    assert.strictEqual(resolveMode('monday', undefined), 'daily');
  });

  it('reverts Monday to the daily brief when the review is disabled', () => {
    assert.strictEqual(resolveMode('monday', { weekly_review: { enabled: false, day: 'monday' } }), 'daily');
  });

  it('honours a review day other than Monday', () => {
    assert.strictEqual(resolveMode('friday', { weekly_review: { enabled: true, day: 'friday' } }), 'weekly');
    assert.strictEqual(resolveMode('monday', { weekly_review: { enabled: true, day: 'friday' } }), 'daily');
  });
});

describe('windowHoursFor', () => {
  const cfg = {
    lookback_hours: 24,
    monday_lookback_hours: 72,
    thread_scan_hours: 168,
    weekly_review: { enabled: true, day: 'monday', lookback_hours: 168, thread_scan_hours: 336 },
  };

  it('covers a trailing week on the review day', () => {
    assert.deepStrictEqual(windowHoursFor('monday', cfg), { mode: 'weekly', lookbackHours: 168, scanHours: 336 });
  });

  it('covers 24h on a normal weekday', () => {
    assert.deepStrictEqual(windowHoursFor('wednesday', cfg), { mode: 'daily', lookbackHours: 24, scanHours: 168 });
  });

  it('falls back to the weekend window on Monday when the review is off', () => {
    const off = { ...cfg, weekly_review: { ...cfg.weekly_review, enabled: false } };
    assert.deepStrictEqual(windowHoursFor('monday', off), { mode: 'daily', lookbackHours: 72, scanHours: 168 });
  });

  it('scans further back than it briefs on, in both modes', () => {
    for (const day of ['monday', 'wednesday']) {
      const w = windowHoursFor(day, cfg);
      assert.ok(w.scanHours >= w.lookbackHours, `${day}: scan ${w.scanHours} < lookback ${w.lookbackHours}`);
    }
  });

  it('brings the weekly window along when a mode is forced off-day', () => {
    // Previewing the review on a Tuesday must not summarize 24h and call it a week.
    assert.deepStrictEqual(windowHoursFor('tuesday', cfg, 'weekly'), {
      mode: 'weekly',
      lookbackHours: 168,
      scanHours: 336,
    });
    assert.deepStrictEqual(windowHoursFor('monday', cfg, 'daily'), {
      mode: 'daily',
      lookbackHours: 72,
      scanHours: 168,
    });
  });

  it('defaults the weekly window when weekly_review omits the hours', () => {
    const bare = { weekly_review: { enabled: true } };
    assert.deepStrictEqual(windowHoursFor('monday', bare), { mode: 'weekly', lookbackHours: 168, scanHours: 336 });
  });
});

describe('compactByDay', () => {
  /** @param {string} iso @param {string} text */
  const msg = (iso, text) => ({ type: 'message', user: 'U1', ts: String(Date.parse(iso) / 1000), text });

  it('groups a week under day headings, oldest day first', () => {
    const text = compactByDay(
      [
        msg('2026-07-27T10:00:00Z', 'monday work'),
        msg('2026-07-29T10:00:00Z', 'wednesday work'),
        msg('2026-07-28T10:00:00Z', 'tuesday work'),
      ],
      { maxChars: 5000, timezone: 'UTC' },
    );
    assert.match(text, /Monday 2026-07-27/);
    assert.match(text, /Tuesday 2026-07-28/);
    assert.match(text, /Wednesday 2026-07-29/);
    assert.ok(text.indexOf('Monday 2026-07-27') < text.indexOf('Wednesday 2026-07-29'), 'days out of order');
  });

  it('buckets by the configured timezone, not UTC', () => {
    // 23:00 UTC Monday is already Tuesday 04:30 in Kolkata.
    const text = compactByDay([msg('2026-07-27T23:00:00Z', 'late')], { maxChars: 5000, timezone: 'Asia/Kolkata' });
    assert.match(text, /Tuesday 2026-07-28/);
  });

  it('drops whole early days and says how many when over budget', () => {
    const long = 'x'.repeat(400);
    const text = compactByDay(
      [msg('2026-07-27T10:00:00Z', long), msg('2026-07-28T10:00:00Z', long), msg('2026-07-29T10:00:00Z', long)],
      { maxChars: 700, timezone: 'UTC' },
    );
    assert.match(text, /earlier day\(s\) of this window omitted/);
    // The newest day survives; that is the point of filling newest-first.
    assert.match(text, /Wednesday 2026-07-29/);
  });

  it('survives a message with an unparseable timestamp', () => {
    const text = compactByDay(
      [{ type: 'message', user: 'U1', ts: 'nonsense', text: 'junk' }, msg('2026-07-29T10:00:00Z', 'real')],
      { maxChars: 5000, timezone: 'UTC' },
    );
    assert.match(text, /Wednesday 2026-07-29/);
    assert.doesNotMatch(text, /junk/);
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

describe('findDirectMentions', () => {
  const ME = 'UDAKSH';
  const msg = (/** @type {any} */ o) => ({ type: 'message', user: 'U1', ts: '100', text: '', ...o });

  it('finds a top-level message that tags the recipient', () => {
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [msg({ ts: '100', user: 'U1', text: `<@${ME}> can you approve this?` })],
      threads: [],
    });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].channel, 'acme-internal');
    assert.strictEqual(found[0].author, '<@U1>');
    assert.strictEqual(found[0].answered, false);
  });

  it('ignores messages that tag somebody else', () => {
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [msg({ text: '<@USOMEONE> can you approve this?' })],
      threads: [],
    });
    assert.deepStrictEqual(found, []);
  });

  it('ignores a message the recipient wrote themselves', () => {
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [msg({ user: ME, text: `cc <@${ME}> for my own reference` })],
      threads: [],
    });
    assert.deepStrictEqual(found, []);
  });

  it('marks a mention ANSWERED when the recipient replied later in the thread', () => {
    const parent = msg({ ts: '100', user: 'U1', text: `<@${ME}> ok to send?`, thread_ts: '100' });
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [parent],
      threads: [{ parent, replies: [msg({ ts: '200', user: ME, text: 'yes, go ahead', thread_ts: '100' })] }],
    });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].answered, true);
  });

  it('leaves a mention OPEN when only someone else replied', () => {
    const parent = msg({ ts: '100', user: 'U1', text: `<@${ME}> ok to send?`, thread_ts: '100' });
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [parent],
      threads: [{ parent, replies: [msg({ ts: '200', user: 'U9', text: 'bumping this', thread_ts: '100' })] }],
    });
    assert.strictEqual(found[0].answered, false);
  });

  it('does not count a recipient reply that predates the mention', () => {
    const parent = msg({ ts: '100', user: ME, text: 'starting this', thread_ts: '100' });
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [parent],
      threads: [{ parent, replies: [msg({ ts: '200', user: 'U1', text: `<@${ME}> your call`, thread_ts: '100' })] }],
    });
    assert.strictEqual(found.length, 1, 'the reply tagging them is the mention');
    assert.strictEqual(found[0].answered, false, 'their earlier message does not answer a later ask');
  });

  it('finds a mention that lives in a thread reply', () => {
    const parent = msg({ ts: '100', user: 'U1', text: 'QA round 3', thread_ts: '100' });
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [],
      threads: [
        { parent, replies: [msg({ ts: '300', user: 'U2', text: `<@${ME}> need a decision`, thread_ts: '100' })] },
      ],
    });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].author, '<@U2>');
  });

  it('returns nothing when there is no recipient to anchor on', () => {
    const found = findDirectMentions({
      recipientId: '',
      channelName: 'acme-internal',
      topLevel: [msg({ text: '<@UDAKSH> hello' })],
      threads: [],
    });
    assert.deepStrictEqual(found, []);
  });

  it('does not double-count a message present as both top-level and thread parent', () => {
    const parent = msg({ ts: '100', user: 'U1', text: `<@${ME}> approve?`, thread_ts: '100' });
    const found = findDirectMentions({
      recipientId: ME,
      channelName: 'acme-internal',
      topLevel: [parent],
      threads: [{ parent, replies: [] }],
    });
    assert.strictEqual(found.length, 1);
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

  it('puts open mentions in the digest as the only source for part 2', () => {
    const { text, openMentions } = buildDigest({
      active: [
        {
          id: 'C1',
          name: 'acme-internal',
          clientKey: 'acme',
          isMember: true,
          source: 'config-internal',
          messageCount: 1,
          text: 'x',
        },
      ],
      mentions: [
        { channel: 'acme-internal', author: '<@U1>', ts: '100', text: 'need your sign-off', answered: false },
        { channel: 'acme-internal', author: '<@U2>', ts: '200', text: 'already sorted', answered: true },
      ],
      recipientName: 'Daksh',
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.strictEqual(openMentions, 1);
    assert.match(text, /TAGGED DAKSH DIRECTLY/);
    assert.match(text, /need your sign-off" — Daksh has NOT replied/);
    assert.match(text, /Already handled[\s\S]*already sorted/);
  });

  it('says plainly when nothing tagged the recipient', () => {
    const { text, openMentions } = buildDigest({
      active: [
        {
          id: 'C1',
          name: 'acme-internal',
          clientKey: 'acme',
          isMember: true,
          source: 'config-internal',
          messageCount: 1,
          text: 'x',
        },
      ],
      mentions: [],
      recipientName: 'Daksh',
      conventions: /** @type {any} */ (conventions),
      since: 'S',
      until: 'U',
    });
    assert.strictEqual(openMentions, 0);
    assert.match(text, /Nothing in the window tagged Daksh and went unanswered/);
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

describe('summarizeChannels', () => {
  /** @param {string} text */
  const fakeQuery = (text) =>
    async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    };

  /** @param {any} over */
  const channel = (over = {}) => ({
    id: 'C1',
    name: 'acme-internal',
    clientKey: 'acme',
    isMember: true,
    source: 'config-internal',
    messageCount: 12,
    activeDays: 3,
    text: '— Monday 2026-07-27 —\n[ts:1] <@U1>: shipped the logo',
    ...over,
  });

  const conventions = conventionsOf({ clients: { acme: { display_name: 'Acme Corp' } } });

  it('summarizes each channel once and labels it with the client', async () => {
    const queryFn = mock.fn(fakeQuery('STATE: fine\nMOVED: - shipped\nBLOCKED: none\nOPEN: none'));
    const out = await summarizeChannels({
      active: /** @type {any} */ ([channel(), channel({ id: 'C2', name: 'pixelup-internal', clientKey: null })]),
      conventions: /** @type {any} */ (conventions),
      query: /** @type {any} */ (queryFn),
    });

    assert.strictEqual(queryFn.mock.callCount(), 2);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].label, '#acme-internal (client: Acme Corp)');
    // A team channel is not labelled as a client's.
    assert.strictEqual(out[1].label, '#pixelup-internal');
    assert.match(out[0].summary, /STATE: fine/);
    assert.strictEqual(out[0].failed, false);
  });

  it('gets the channel text as untrusted data, with no tools', async () => {
    const queryFn = mock.fn(fakeQuery('STATE: fine'));
    await summarizeChannels({
      active: /** @type {any} */ ([channel()]),
      conventions: /** @type {any} */ (conventions),
      query: /** @type {any} */ (queryFn),
    });
    const call = /** @type {any} */ (queryFn.mock.calls[0].arguments[0]);
    assert.match(call.prompt, /shipped the logo/);
    assert.match(call.prompt, /untrusted/i);
    assert.deepStrictEqual(call.options.allowedTools, []);
    assert.strictEqual(call.options.maxTurns, 1);
  });

  it('falls back to raw messages when one channel fails, keeping the rest', async () => {
    let n = 0;
    const queryFn = () => {
      n++;
      if (n === 1) throw new Error('model exploded');
      return fakeQuery('STATE: fine')();
    };
    const errors = [];
    const out = await summarizeChannels({
      active: /** @type {any} */ ([channel(), channel({ id: 'C2', name: 'beta-internal', clientKey: null })]),
      conventions: /** @type {any} */ (conventions),
      query: /** @type {any} */ (queryFn),
      logger: { info: () => {}, error: (/** @type {string} */ m) => errors.push(m) },
    });

    assert.strictEqual(out.length, 2);
    const failed = out.find((s) => s.failed);
    assert.ok(failed, 'expected one failed summary');
    assert.match(/** @type {any} */ (failed).summary, /Summary unavailable/);
    // The channel is still represented rather than silently missing.
    assert.match(/** @type {any} */ (failed).summary, /shipped the logo/);
    assert.strictEqual(out.filter((s) => !s.failed).length, 1);
    assert.strictEqual(errors.length, 1);
  });

  it('treats an empty model response as a failure rather than an empty section', async () => {
    const out = await summarizeChannels({
      active: /** @type {any} */ ([channel()]),
      conventions: /** @type {any} */ (conventions),
      query: /** @type {any} */ (fakeQuery('   ')),
      logger: { info: () => {}, error: () => {} },
    });
    assert.strictEqual(out[0].failed, true);
  });
});

describe('buildWeeklyDigest', () => {
  /** @param {any} over */
  const summaryOf = (over = {}) => ({
    channel: {
      id: 'C1',
      name: 'acme-internal',
      clientKey: 'acme',
      isMember: true,
      source: 'config-internal',
      messageCount: 40,
      activeDays: 4,
      ...(over.channel || {}),
    },
    label: over.label || '#acme-internal (client: Acme Corp)',
    summary: over.summary || 'STATE: on track\nMOVED: - shipped Tuesday\nBLOCKED: none\nOPEN: none',
    failed: over.failed ?? false,
  });

  const conventions = conventionsOf({
    clients: { acme: { display_name: 'Acme Corp' }, sully: { display_name: 'Sully' } },
  });

  it('marks itself a weekly review and carries each summary', () => {
    const { text, includedChannels } = buildWeeklyDigest({
      summaries: /** @type {any} */ ([summaryOf()]),
      conventions: /** @type {any} */ (conventions),
      since: '2026-07-27T05:27:00Z',
      until: '2026-08-03T05:27:00Z',
    });
    assert.match(text, /WEEKLY REVIEW/);
    assert.match(text, /last 7 days/);
    assert.match(text, /40 message\(s\) this week, active on 4 day\(s\)/);
    assert.match(text, /STATE: on track/);
    assert.deepStrictEqual(includedChannels, ['#acme-internal']);
  });

  it('names projects that were silent all week', () => {
    const { text } = buildWeeklyDigest({
      summaries: /** @type {any} */ ([summaryOf()]),
      quiet: /** @type {any} */ ([{ id: 'C9', name: 'sully-internal', clientKey: 'sully', isMember: true }]),
      conventions: /** @type {any} */ (conventions),
      since: 'a',
      until: 'b',
    });
    assert.match(text, /NO activity ALL WEEK/);
    assert.match(text, /Sully/);
  });

  it('reports which summaries failed', () => {
    const { failedSummaries } = buildWeeklyDigest({
      summaries: /** @type {any} */ ([
        summaryOf(),
        summaryOf({ channel: { id: 'C2', name: 'beta-internal', clientKey: null }, failed: true }),
      ]),
      conventions: /** @type {any} */ (conventions),
      since: 'a',
      until: 'b',
    });
    assert.deepStrictEqual(failedSummaries, ['#beta-internal']);
  });

  it('drops channels over the total budget and says which', () => {
    const big = 'y'.repeat(3000);
    const { droppedChannels, includedChannels } = buildWeeklyDigest({
      summaries: /** @type {any} */ ([
        summaryOf({ summary: big, channel: { messageCount: 100 } }),
        summaryOf({ summary: big, channel: { id: 'C2', name: 'beta-internal', clientKey: null, messageCount: 10 } }),
      ]),
      conventions: /** @type {any} */ (conventions),
      since: 'a',
      until: 'b',
      totalMaxChars: 3500,
    });
    assert.deepStrictEqual(includedChannels, ['#acme-internal']);
    assert.deepStrictEqual(droppedChannels, ['#beta-internal']);
  });

  it('has no mention block — "Needs you" is a daily-brief concept', () => {
    const { text } = buildWeeklyDigest({
      summaries: /** @type {any} */ ([summaryOf()]),
      conventions: /** @type {any} */ (conventions),
      since: 'a',
      until: 'b',
    });
    assert.doesNotMatch(text, /TAGGED/);
    assert.doesNotMatch(text, /Needs you|part 2/i);
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

  it('anchors "Needs you" on the RECIPIENT, not on whoever is mentioned most', async () => {
    // The bug this guards: the prompt used to say "the founder" with no ID, so the
    // model inferred the reader from context. Here U1 is tagged three times and the
    // recipient (U1 is NOT the recipient) once — only the recipient's tag counts.
    const t = Number(recentTs());
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: {
        C1: [
          { type: 'message', user: 'U9', ts: String(t), text: '<@U1> and <@U1> and <@U1> please look' },
          { type: 'message', user: 'U9', ts: String(t + 10), text: '<@UDAKSH> need your decision' },
        ],
      },
    });
    const conv = {
      ...conventions,
      users: { UDAKSH: { name: 'Daksh', clickup_user_id: 2, role: 'lead' } },
    };
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conv),
      recipientId: 'UDAKSH',
      deliver: false,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.strictEqual(result.recipientName, 'Daksh');
    assert.deepStrictEqual(
      result.mentions.map((m) => m.text),
      ['<@UDAKSH> need your decision'],
      'only the recipient tag becomes a candidate',
    );
    assert.match(result.digest, /TAGGED DAKSH DIRECTLY/);
    assert.match(result.digest, /Daksh has NOT replied/);
  });

  it('previews another person\'s brief without re-anchoring "Needs you" on the reader', async () => {
    // Sending Arjun a preview of Daksh's brief must still compute Needs you for
    // DAKSH — otherwise the test copy quietly reports the wrong person's asks.
    const t = Number(recentTs());
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: {
        C1: [
          { type: 'message', user: 'U9', ts: String(t), text: '<@UDAKSH> your call on this' },
          { type: 'message', user: 'U9', ts: String(t + 5), text: '<@UARJUN> fyi only' },
        ],
      },
    });
    const conv = {
      ...conventions,
      users: {
        UDAKSH: { name: 'Daksh', clickup_user_id: 2, role: 'lead' },
        UARJUN: { name: 'Arjun', clickup_user_id: 1, role: 'lead' },
      },
    };
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conv),
      recipientId: 'UDAKSH',
      deliverTo: 'UARJUN',
      deliver: true,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.strictEqual(result.recipientName, 'Daksh', 'subject stays Daksh');
    assert.deepStrictEqual(
      result.mentions.map((m) => m.text),
      ['<@UDAKSH> your call on this'],
      "Arjun's mention must not become a candidate",
    );
    // ...but the DM went to Arjun.
    assert.strictEqual(client.conversations.open.mock.calls[0].arguments[0].users, 'UARJUN');
    assert.strictEqual(result.deliveredTo, 'D1');
  });

  it('delivers to the subject when no separate target is given', async () => {
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: { C1: [{ type: 'message', user: 'U9', ts: recentTs(), text: 'hello' }] },
    });
    await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ (conventions),
      recipientId: 'UDAKSH',
      deliver: true,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    assert.strictEqual(client.conversations.open.mock.calls[0].arguments[0].users, 'UDAKSH');
  });

  it('reports no candidates when the recipient was never tagged', async () => {
    const client = slackClient({
      channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
      history: { C1: [{ type: 'message', user: 'U9', ts: recentTs(), text: 'is this good enough to send?' }] },
    });
    const result = await runDailyBrief({
      client: /** @type {any} */ (client),
      conventions: /** @type {any} */ ({
        ...conventions,
        users: { UDAKSH: { name: 'Daksh', clickup_user_id: 2, role: 'lead' } },
      }),
      recipientId: 'UDAKSH',
      deliver: false,
      query: /** @type {any} */ (fakeQuery('brief body')),
    });
    // An untagged approval question must NOT become a "Needs you" candidate.
    assert.deepStrictEqual(result.mentions, []);
    assert.match(result.digest, /Nothing in the window tagged Daksh and went unanswered/);
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

  describe('weekly review', () => {
    const weeklyConventions = conventionsOf({
      clients: { acme: { display_name: 'Acme Corp', internal_channel_id: 'C1' } },
      daily_brief: {
        timezone: 'UTC',
        lookback_hours: 24,
        weekly_review: { enabled: true, day: 'monday', lookback_hours: 168, thread_scan_hours: 336 },
      },
    });

    /** A ts a few days back — inside the weekly window, outside the daily one. */
    const daysAgoTs = (/** @type {number} */ n) => String(Math.floor(Date.now() / 1000) - n * 24 * 3600);

    /**
     * Distinguishes the map calls from the reduce call: the per-channel prompt asks
     * for the four labelled lines, the reduce prompt asks for the review.
     * @param {any} call
     */
    const isReduceCall = (call) => /weekly review now/.test(call.arguments[0].prompt);

    it('maps per channel then reduces, and says it is a weekly review', async () => {
      const client = slackClient({
        channels: [
          { id: 'C1', name: 'acme-internal', is_member: true },
          { id: 'C3', name: 'beta-internal', is_member: true },
        ],
        history: {
          C1: [{ type: 'message', user: 'U1', ts: daysAgoTs(5), text: 'logo shipped' }],
          C3: [{ type: 'message', user: 'U2', ts: daysAgoTs(3), text: 'kickoff done' }],
        },
      });
      const queryFn = mock.fn(fakeQuery('*:one: Last week*\n• *Acme* — shipped.'));
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (
          conventionsOf({
            clients: {
              acme: { display_name: 'Acme Corp', internal_channel_id: 'C1' },
              beta: { display_name: 'Beta', internal_channel_id: 'C3' },
            },
            daily_brief: weeklyConventions.daily_brief,
          })
        ),
        recipientId: 'U1',
        mode: 'weekly',
        deliver: false,
        query: /** @type {any} */ (queryFn),
      });

      assert.strictEqual(result.mode, 'weekly');
      // Two channels → two map calls, plus one reduce.
      assert.strictEqual(queryFn.mock.callCount(), 3);
      assert.strictEqual(queryFn.mock.calls.filter(isReduceCall).length, 1);
      assert.match(result.digest, /WEEKLY REVIEW/);
      // Activity 5 days old is in the week's window but would miss a 24h one.
      assert.strictEqual(result.active.length, 2);
    });

    it('reduces from the summaries, not the raw messages', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: { C1: [{ type: 'message', user: 'U1', ts: daysAgoTs(4), text: 'SECRET_RAW_TOKEN' }] },
      });
      const queryFn = mock.fn(fakeQuery('STATE: summarized, no raw text here'));
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'weekly',
        deliver: false,
        query: /** @type {any} */ (queryFn),
      });

      const reduce = queryFn.mock.calls.find(isReduceCall);
      assert.ok(reduce, 'expected a reduce call');
      // The map stage saw the raw messages; the reduce stage sees only summaries.
      assert.match(/** @type {any} */ (reduce).arguments[0].prompt, /STATE: summarized/);
      assert.doesNotMatch(/** @type {any} */ (reduce).arguments[0].prompt, /SECRET_RAW_TOKEN/);
      assert.doesNotMatch(result.digest, /SECRET_RAW_TOKEN/);
    });

    it('uses day headings in the text handed to the map stage', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: {
          C1: [
            { type: 'message', user: 'U1', ts: daysAgoTs(5), text: 'early' },
            { type: 'message', user: 'U1', ts: daysAgoTs(1), text: 'late' },
          ],
        },
      });
      const queryFn = mock.fn(fakeQuery('STATE: fine'));
      await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'weekly',
        deliver: false,
        query: /** @type {any} */ (queryFn),
      });
      const map = queryFn.mock.calls.find((c) => !isReduceCall(c));
      assert.match(/** @type {any} */ (map).arguments[0].prompt, /— \w+day \d{4}-\d{2}-\d{2} —/);
    });

    it('collects no mentions and puts no "Needs you" material in the digest', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: {
          C1: [
            // Would be an open mention in daily mode — must not surface weekly.
            { type: 'message', user: 'U2', ts: daysAgoTs(6), text: '<@U1> need your call on this' },
            { type: 'message', user: 'U2', ts: daysAgoTs(2), text: 'unrelated chatter' },
          ],
        },
      });
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'weekly',
        deliver: false,
        query: /** @type {any} */ (fakeQuery('review body')),
      });

      assert.deepStrictEqual(result.mentions, []);
      assert.doesNotMatch(result.digest, /TAGGED/);
      // The message itself still reaches the map stage as project activity.
      assert.strictEqual(result.active.length, 1);
    });

    it('still collects mentions on the daily path with the same data', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: { C1: [{ type: 'message', user: 'U2', ts: recentTs(), text: '<@U1> need your call on this' }] },
      });
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'daily',
        deliver: false,
        query: /** @type {any} */ (fakeQuery('brief body')),
      });

      assert.strictEqual(result.mentions.length, 1);
      assert.match(result.digest, /TAGGED ARJUN DIRECTLY/);
    });

    it('sends a weekly no-activity note without calling the model', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: { C1: [] },
      });
      const queryFn = mock.fn(fakeQuery('should not run'));
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'weekly',
        deliver: true,
        query: /** @type {any} */ (queryFn),
      });

      assert.strictEqual(queryFn.mock.callCount(), 0);
      assert.match(result.brief, /Weekly review/);
      assert.match(result.brief, /last week/);
      assert.strictEqual(result.deliveredTo, 'D1');
    });

    it('footnotes a channel whose summary failed', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: { C1: [{ type: 'message', user: 'U1', ts: daysAgoTs(3), text: 'work' }] },
      });
      let n = 0;
      const queryFn = () => {
        n++;
        if (n === 1) throw new Error('map failed');
        return fakeQuery('review body')();
      };
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'weekly',
        deliver: false,
        query: /** @type {any} */ (queryFn),
        logger: { info: () => {}, error: () => {} },
      });
      assert.match(result.brief, /Summarizing failed for #acme-internal/);
    });

    it('takes the daily path with no map stage when the mode is daily', async () => {
      const client = slackClient({
        channels: [{ id: 'C1', name: 'acme-internal', is_member: true }],
        history: { C1: [{ type: 'message', user: 'U1', ts: recentTs(), text: 'today only' }] },
      });
      const queryFn = mock.fn(fakeQuery('brief body'));
      const result = await runDailyBrief({
        client: /** @type {any} */ (client),
        conventions: /** @type {any} */ (weeklyConventions),
        recipientId: 'U1',
        mode: 'daily',
        deliver: false,
        query: /** @type {any} */ (queryFn),
      });

      assert.strictEqual(result.mode, 'daily');
      // One write-up call only — no per-channel summaries.
      assert.strictEqual(queryFn.mock.callCount(), 1);
      assert.doesNotMatch(result.digest, /WEEKLY REVIEW/);
    });
  });
});
