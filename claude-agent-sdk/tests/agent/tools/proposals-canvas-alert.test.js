import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { createProposalTools, resetRegistrationAlertCache } from '../../../agent/tools/proposals.js';
import { resetChannelCache } from '../../../agent/tools/slack-read.js';
import { resetResolverCache } from '../../../config/resolver.js';

/**
 * The unregistered-client alert on canvas proposals: proposing a canvas in a
 * `{key}-internal` channel whose key is not a registered client DMs the
 * configured lead — once per client key, best-effort, never for registered
 * clients or channels that aren't client-internal.
 */

const ALERT_TO = 'U0000000LEAD';
const REQUESTER = 'U000000MEMBR';

/** @returns {any} Minimal conventions for the canvas path. */
function conventions(overrides = {}) {
  return {
    clients: {
      acme: { display_name: 'Acme', channel_id: 'C0ACME', internal_channel_id: 'C0ACMEINT' },
    },
    users: {
      [ALERT_TO]: { name: 'Example Lead', clickup_user_id: 1, role: 'lead' },
      [REQUESTER]: { name: 'Example Designer', clickup_user_id: 2, role: 'member' },
    },
    channels: { drafts_channel_id: '', registration_alert_slack_id: ALERT_TO },
    ...overrides,
  };
}

/**
 * Slack fake: `conversations.info` names each channel, `chat.postMessage`
 * records everything (approval cards and alert DMs alike).
 * @param {Record<string, string>} namesById
 */
function slackClient(namesById) {
  return {
    conversations: {
      info: mock.fn(async (/** @type {any} */ { channel }) => ({ channel: { name: namesById[channel] } })),
    },
    chat: {
      postMessage: mock.fn(async (/** @type {any} */ args) => ({ channel: args.channel, ts: '1111.2222' })),
    },
  };
}

/** @param {any} client @param {any} conv @param {string} [userId] */
function canvasTool(client, conv, userId = REQUESTER) {
  const deps = { client, userId, channelId: 'D0DMCHANNEL', threadTs: '1.0', channelType: 'im' };
  const tools = createProposalTools(/** @type {any} */ (deps), conv);
  return tools.find((/** @type {any} */ t) => t.name === 'propose_canvas_update');
}

/** All chat.postMessage calls that are NOT approval cards (no blocks). @param {any} client */
function alertDms(client) {
  return client.chat.postMessage.mock.calls.filter((/** @type {any} */ c) => !c.arguments[0].blocks);
}

describe('canvas proposal → unregistered-client alert', () => {
  beforeEach(() => {
    resetResolverCache();
    resetChannelCache();
    resetRegistrationAlertCache();
  });

  it('DMs the configured lead when the target is an unregistered {key}-internal channel', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = canvasTool(client, conventions());
    const result = await tool.handler({ channel: 'C0VARICKINT', markdown: '# Guidelines' }, {});
    assert.match(result.content[0].text, /Proposal posted/);
    const dms = alertDms(client);
    assert.strictEqual(dms.length, 1);
    const dm = dms[0].arguments[0];
    assert.strictEqual(dm.channel, ALERT_TO);
    assert.match(dm.text, /varick/);
    assert.match(dm.text, new RegExp(`<@${REQUESTER}>`));
    assert.match(dm.text, /register varick/);
  });

  it('stays quiet for a registered client', async () => {
    const client = slackClient({ C0ACMEINT: 'acme-internal' });
    const tool = canvasTool(client, conventions());
    const result = await tool.handler({ channel: 'C0ACMEINT', markdown: '# Status' }, {});
    assert.match(result.content[0].text, /Proposal posted/);
    assert.strictEqual(alertDms(client).length, 0);
  });

  it('stays quiet for a non-client internal channel', async () => {
    const client = slackClient({ C0TEAM: 'design-team' });
    const tool = canvasTool(client, conventions());
    const result = await tool.handler({ channel: 'C0TEAM', markdown: '# Notes' }, {});
    assert.match(result.content[0].text, /Proposal posted/);
    assert.strictEqual(alertDms(client).length, 0);
  });

  it('dedupes: a second proposal for the same client key sends no second DM', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = canvasTool(client, conventions());
    await tool.handler({ channel: 'C0VARICKINT', markdown: '# v1' }, {});
    await tool.handler({ channel: 'C0VARICKINT', markdown: '# v2' }, {});
    assert.strictEqual(alertDms(client).length, 1);
  });

  it('a failed DM does not fail the proposal, and does not claim the dedupe slot', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    let failNext = true;
    const post = client.chat.postMessage;
    client.chat.postMessage = mock.fn(async (/** @type {any} */ args) => {
      if (!args.blocks && failNext) {
        failNext = false;
        throw new Error('slack down');
      }
      return post(args);
    });
    const tool = canvasTool(client, conventions());
    const first = await tool.handler({ channel: 'C0VARICKINT', markdown: '# v1' }, {});
    assert.match(first.content[0].text, /Proposal posted/);
    // Retry path: the DM failed above, so the next proposal alerts again — and
    // this one lands. Count DELIVERED DMs on the inner mock (the wrapper also
    // records the call it failed).
    await tool.handler({ channel: 'C0VARICKINT', markdown: '# v2' }, {});
    const delivered = post.mock.calls.filter((/** @type {any} */ c) => !c.arguments[0].blocks);
    assert.strictEqual(delivered.length, 1, 'exactly one DM is delivered');
  });

  it('never DMs the requester about their own proposal', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = canvasTool(client, conventions(), ALERT_TO);
    await tool.handler({ channel: 'C0VARICKINT', markdown: '# Guidelines' }, {});
    assert.strictEqual(alertDms(client).length, 0);
  });

  it('stays quiet when no alert recipient is configured', async () => {
    const conv = conventions({ channels: { drafts_channel_id: '' } });
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = canvasTool(client, conv);
    await tool.handler({ channel: 'C0VARICKINT', markdown: '# Guidelines' }, {});
    assert.strictEqual(alertDms(client).length, 0);
  });
});
