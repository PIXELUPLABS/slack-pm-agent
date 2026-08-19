import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { createProposalTools, resetRegistrationAlertCache } from '../../../agent/tools/proposals.js';
import { resetChannelCache } from '../../../agent/tools/slack-read.js';
import { resetResolverCache } from '../../../config/resolver.js';

/**
 * propose_channel_message: the internal-only "post a message / remind someone"
 * path. The parts that matter are all deterministic — mentions are rendered
 * from IDs in code (a model typing "@name" notifies nobody), channel-wide
 * pings are stripped, and client channels are refused by NAME, fail-closed.
 */

const REQUESTER = 'U000000MEMBR';
const KRISH = 'U0A5CBCQWSY';
const UNKNOWN = 'U0BNF05TG3S';

/** @returns {any} Minimal conventions for the message path. */
function conventions(overrides = {}) {
  return {
    clients: {
      acme: { display_name: 'Acme', channel_id: 'C0ACME', internal_channel_id: 'C0ACMEINT' },
    },
    users: {
      [REQUESTER]: { name: 'Example Designer', clickup_user_id: 2, role: 'member' },
      [KRISH]: { name: 'Krish Savani', clickup_user_id: 3, role: 'lead' },
    },
    channels: { drafts_channel_id: '', registration_alert_slack_id: '' },
    ...overrides,
  };
}

/** @param {Record<string, string>} namesById */
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

/** @param {any} client @param {any} conv */
function messageTool(client, conv) {
  const deps = { client, userId: REQUESTER, channelId: 'D0DMCHANNEL', threadTs: '1.0', channelType: 'im' };
  const tools = createProposalTools(/** @type {any} */ (deps), conv);
  return tools.find((/** @type {any} */ t) => t.name === 'propose_channel_message');
}

/** The approval card that was posted (the only postMessage with blocks). @param {any} client */
function card(client) {
  const call = client.chat.postMessage.mock.calls.find((/** @type {any} */ c) => c.arguments[0].blocks);
  return call ? call.arguments[0] : null;
}

/** Flattened card text, for asserting what the approver sees. @param {any} client */
function cardText(client) {
  return JSON.stringify(card(client)?.blocks || []);
}

describe('propose_channel_message', () => {
  beforeEach(() => {
    resetResolverCache();
    resetChannelCache();
    resetRegistrationAlertCache();
  });

  it('posts an approval card for an internal channel', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = messageTool(client, conventions());

    const result = await tool.handler({ channel: 'C0VARICKINT', text: 'please drop a Varick update' }, {});

    assert.match(result.content[0].text, /Proposal posted for approval/);
    assert.match(cardText(client), /varick-internal|C0VARICKINT/);
  });

  it('refuses a client-facing channel', async () => {
    const client = slackClient({ C0VARICK: 'varick-pixelup' });
    const tool = messageTool(client, conventions());

    const result = await tool.handler({ channel: 'C0VARICK', text: 'hello' }, {});

    assert.match(result.content[0].text, /Refused/);
    assert.strictEqual(card(client), null);
  });

  it('refuses a channel it cannot identify (fail-closed)', async () => {
    const client = slackClient({});
    const tool = messageTool(client, conventions());

    const result = await tool.handler({ channel: 'C0MYSTERY', text: 'hello' }, {});

    assert.match(result.content[0].text, /Refused/);
    assert.strictEqual(card(client), null);
  });

  it('keeps mention IDs on the payload and shows display names on the card', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = messageTool(client, conventions());

    await tool.handler({ channel: 'C0VARICKINT', text: 'please drop a Varick update', mention_slack_ids: [KRISH] }, {});

    const text = cardText(client);
    assert.match(text, /Krish Savani/);
    // The card must NOT render <@ID> — that would notify off the pending card.
    assert.ok(!text.includes(`<@${KRISH}>`), 'approval card must not contain live mention markup');
  });

  it('mentions a user who is not in the team roster, and says so', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = messageTool(client, conventions());

    const result = await tool.handler(
      { channel: 'C0VARICKINT', text: 'update please', mention_slack_ids: [UNKNOWN, KRISH] },
      {},
    );

    assert.match(result.content[0].text, /Proposal posted for approval/);
    assert.match(cardText(client), /not in the team roster/);
  });

  it('accepts an already-wrapped <@ID> and dedupes repeats', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = messageTool(client, conventions());

    await tool.handler({ channel: 'C0VARICKINT', text: 'ping', mention_slack_ids: [`<@${KRISH}>`, KRISH] }, {});

    const names = cardText(client).match(/Krish Savani/g) || [];
    assert.strictEqual(names.length, 1, 'the same user must be mentioned once');
  });

  it('strips channel-wide pings from the message body', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = messageTool(client, conventions());

    await tool.handler({ channel: 'C0VARICKINT', text: '<!here> standup moved @channel' }, {});

    const text = cardText(client);
    assert.ok(!text.includes('<!here>'), '<!here> must not survive');
    assert.ok(!text.includes('@channel'), '@channel must not survive');
    assert.match(text, /standup moved/);
  });

  it('refuses a message that is empty once pings are stripped', async () => {
    const client = slackClient({ C0VARICKINT: 'varick-internal' });
    const tool = messageTool(client, conventions());

    const result = await tool.handler({ channel: 'C0VARICKINT', text: '<!channel>' }, {});

    assert.match(result.content[0].text, /Refused/);
    assert.strictEqual(card(client), null);
  });
});
