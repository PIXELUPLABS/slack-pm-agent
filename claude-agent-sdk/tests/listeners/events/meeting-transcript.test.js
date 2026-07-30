import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = fileURLToPath(new URL('../../fixtures/conventions.json', import.meta.url));

import { resetConventionsCache } from '../../../config/index.js';
import {
  handleMeetingTranscript,
  hasExternalParticipant,
  isNotesMessage,
  matchClientForMeeting,
  parseTranscriptHeader,
  resetProcessed,
} from '../../../listeners/events/meeting-transcript.js';

// From the fixture.
const TRANSCRIPT_CHANNEL = 'C0TRANSCRIPT';
const INTERNAL_CHANNEL = 'C0INTERNAL0';

const CLIENT_HEADER = [
  'Title: Example Client <> PIXELUPLABS - Check In',
  'Date: Wed, Jul 15th - 09:00 PM IST',
  'Participants: krish@pixelup.in, melissa@example.com, design@pixelup.in',
  'Brand Direction: Favor Ideation A.',
].join('\n');

const NOTES = [
  'Keywords: Branding, Logo',
  '',
  'Notes: Brand exploration.',
  'Action Items',
  'Krish Savani',
  'Ship logo.',
].join('\n');

/** @param {string} parentText @param {string} notesText */
function makeClient(parentText, notesText) {
  return {
    conversations: {
      replies: mock.fn(async () => ({ messages: [{ text: parentText }, { text: notesText }] })),
    },
    chat: { postMessage: mock.fn(async () => ({ ok: true })) },
  };
}

/** @param {object} [overrides] */
function makeEvent(overrides = {}) {
  return { channel: TRANSCRIPT_CHANNEL, ts: '2.0', thread_ts: '1.0', bot_id: 'B0FIRE', text: NOTES, ...overrides };
}

describe('meeting-transcript pure helpers', () => {
  it('parses Title and Participants from a header', () => {
    const header = parseTranscriptHeader(CLIENT_HEADER);
    assert.strictEqual(header.title, 'Example Client <> PIXELUPLABS - Check In');
    assert.deepStrictEqual(header.participantEmails, ['krish@pixelup.in', 'melissa@example.com', 'design@pixelup.in']);
  });

  it('detects the notes/action-items message', () => {
    assert.ok(isNotesMessage(NOTES));
    assert.ok(!isNotesMessage('Title: A <> B\nParticipants: x@y.com'));
  });

  it('flags external participants but not all-internal ones', () => {
    assert.ok(hasExternalParticipant({ participantEmails: ['a@pixelup.in', 'b@example.com'] }, ['pixelup.in']));
    assert.ok(!hasExternalParticipant({ participantEmails: ['a@pixelup.in', 'b@pixelup.in'] }, ['pixelup.in']));
  });

  it('matches a client by name in the title', () => {
    const conventions = { clients: { 'example-client': { display_name: 'Example Client' } } };
    const match = matchClientForMeeting(conventions, { title: 'Example Client <> PIXELUPLABS', participantEmails: [] });
    assert.strictEqual(match?.key, 'example-client');
  });

  it('matches by participant email domain when the title has no name', () => {
    const conventions = { clients: { acme: { display_name: 'Acme', email_domains: ['acme.io'] } } };
    const match = matchClientForMeeting(conventions, { title: 'Weekly Sync', participantEmails: ['x@acme.io'] });
    assert.strictEqual(match?.key, 'acme');
  });

  it('returns null when nothing matches', () => {
    const conventions = { clients: { acme: { display_name: 'Acme' } } };
    assert.strictEqual(matchClientForMeeting(conventions, { title: 'Unknown Co Call', participantEmails: [] }), null);
  });
});

describe('handleMeetingTranscript', () => {
  let logger;
  let summarize;

  beforeEach(() => {
    resetConventionsCache();
    resetProcessed();
    logger = { info: mock.fn(), error: mock.fn() };
    summarize = mock.fn(async () => 'RECAP TEXT');
  });

  it('posts a recap to the client internal channel for a client call', async () => {
    const client = makeClient(CLIENT_HEADER, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });

    assert.strictEqual(summarize.mock.callCount(), 1);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
    const call = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(call.channel, INTERNAL_CHANNEL);
    assert.strictEqual(call.text, 'RECAP TEXT');
  });

  it('ignores internal team meetings (all-internal participants)', async () => {
    const internalHeader = ['Title: Daily Standup', 'Participants: krish@pixelup.in, design@pixelup.in'].join('\n');
    const client = makeClient(internalHeader, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });

    assert.strictEqual(summarize.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('warns in-thread when the matched client has no internal channel', async () => {
    const header = [
      'Title: Nointernal <> PIXELUPLABS - Sync',
      'Participants: krish@pixelup.in, ext@somewhere.com',
    ].join('\n');
    const client = makeClient(header, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });

    assert.strictEqual(summarize.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
    const call = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(call.channel, TRANSCRIPT_CHANNEL);
    assert.strictEqual(call.thread_ts, '1.0');
    assert.match(call.text, /no internal channel is configured/);
  });

  it('warns in-thread when the client cannot be identified', async () => {
    const header = ['Title: Mystery Co <> PIXELUPLABS', 'Participants: krish@pixelup.in, a@mystery.co'].join('\n');
    const client = makeClient(header, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });

    assert.strictEqual(summarize.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
    assert.match(client.chat.postMessage.mock.calls[0].arguments[0].text, /couldn't match this meeting/);
  });

  it('ignores messages outside the transcripts channel', async () => {
    const client = makeClient(CLIENT_HEADER, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent({ channel: 'C0SOMEWHERE' }), logger }, { summarize });
    assert.strictEqual(client.conversations.replies.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('ignores non-notes messages (the header parent)', async () => {
    const client = makeClient(CLIENT_HEADER, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent({ text: CLIENT_HEADER }), logger }, { summarize });
    assert.strictEqual(client.conversations.replies.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('ignores human (non-bot) messages', async () => {
    const client = makeClient(CLIENT_HEADER, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent({ bot_id: undefined }), logger }, { summarize });
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('does not post a second recap for the same thread', async () => {
    const client = makeClient(CLIENT_HEADER, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
    assert.strictEqual(summarize.mock.callCount(), 1);
  });
});
