import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = fileURLToPath(new URL('../../fixtures/conventions.json', import.meta.url));

import { resetConventionsCache } from '../../../config/index.js';
import {
  handleMeetingTranscript,
  hasExternalParticipant,
  ignoredTitlePattern,
  isNotesMessage,
  matchClientForMeeting,
  parseTranscriptHeader,
  resetProcessed,
} from '../../../listeners/events/meeting-transcript.js';

// From the fixture.
const TRANSCRIPT_CHANNEL = 'C0TRANSCRIPT';
const INTERNAL_CHANNEL = 'C0INTERNAL0';

// REAL Slack wire format — bold labels and auto-linked emails. Tests used to
// use prettified text, which is why they passed while production silently did
// nothing on every actual Fireflies post.
const CLIENT_HEADER = [
  '*Title:* <https://app.fireflies.ai/view/abc|Example Client <> PIXELUPLABS - Check In>',
  '*Date:* Wed, Jul 15th - 09:00 PM IST',
  '*Participants:* <mailto:krish@pixelup.in|krish@pixelup.in>, <mailto:melissa@example.com|melissa@example.com>, <mailto:design@pixelup.in|design@pixelup.in>',
  '*Brand Direction:* Favor Ideation A.',
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
    // The "<>" is dropped: it is indistinguishable from Slack link scaffolding,
    // and the title is only used to match a client name.
    assert.strictEqual(header.title, 'Example Client PIXELUPLABS - Check In');
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

  it('ignores a standup even when an outsider joined (title rule wins)', async () => {
    // A contractor or candidate in a standup must not turn it into a client call.
    const header = [
      '*Title:* <https://app.fireflies.ai/view/s|PIXELUP Daily Stand-Up>',
      '*Participants:* <mailto:krish@pixelup.in|krish@pixelup.in>, <mailto:guest@outside.com|guest@outside.com>',
    ].join('\n');
    const client = makeClient(header, NOTES);
    await handleMeetingTranscript({ client, event: makeEvent(), logger }, { summarize });
    assert.strictEqual(summarize.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
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

describe('parseTranscriptHeader — Slack wire format (regression)', () => {
  it('parses the bold-label, mailto-linked message Slack actually delivers', () => {
    // Verbatim shape of the FuseAI <> PIXELUP Weekly Sync post that the bot
    // silently ignored on 2026-07-28.
    const raw = [
      '*Title:* <https://app.fireflies.ai/view/x|FuseAI <> PIXELUP Weekly Sync>',
      '*Date:* Tue, Jul 28th - 09:30 PM IST (23 mins)',
      '*Participants:* <mailto:nicolas@tryfuse.ai|nicolas@tryfuse.ai>, <mailto:jj@pixelup.in|jj@pixelup.in>, <mailto:daksh@pixeluplabs.com|daksh@pixeluplabs.com>',
    ].join('\n');
    const header = parseTranscriptHeader(raw);
    // The client name must survive normalization or the meeting matches nothing.
    assert.match(header.title, /FuseAI/);
    assert.deepStrictEqual(header.participantEmails, ['nicolas@tryfuse.ai', 'jj@pixelup.in', 'daksh@pixeluplabs.com']);
  });

  it('still parses plain text, so both shapes work', () => {
    const header = parseTranscriptHeader('Title: Acme <> PIXELUP\nParticipants: a@acme.com, b@pixelup.in');
    assert.strictEqual(header.title, 'Acme PIXELUP');
    assert.deepStrictEqual(header.participantEmails, ['a@acme.com', 'b@pixelup.in']);
  });

  it('keeps only real addresses, so a mangled line cannot invent a domain', () => {
    const header = parseTranscriptHeader('Title: X\nParticipants: not-an-email, a@acme.com, also bad');
    assert.deepStrictEqual(header.participantEmails, ['a@acme.com']);
  });

  it('treats a pixeluplabs.com-only meeting as internal', () => {
    // daksh@pixeluplabs.com is one of us; with only pixelup.in configured, an
    // all-internal standup was being routed as a client call.
    const header = parseTranscriptHeader('Title: PIXELUP Standup\nParticipants: jj@pixelup.in, daksh@pixeluplabs.com');
    assert.strictEqual(hasExternalParticipant(header, ['pixelup.in', 'pixeluplabs.com']), false);
  });
});

describe('ignoredTitlePattern', () => {
  const PATTERNS = ['standup', 'retro', 'allhands', 'internalsync', 'huddle', 'teamsync', 'leadership'];

  it('ignores internal ceremonies across every spelling', () => {
    for (const title of [
      'Daily Stand Up',
      'Daily Stand-Up',
      'DailyStandup',
      'PIXELUP Standup',
      'Sprint Retro',
      'Retrospective - July',
      'All Hands',
      'Internal Sync',
      'Team Sync',
      'Design Huddle',
      'Leadership Weekly',
    ]) {
      assert.ok(ignoredTitlePattern(title, PATTERNS), `should ignore: ${title}`);
    }
  });

  it('NEVER ignores a real client call — the reason "sync" is not a pattern', () => {
    // "FuseAI <> PIXELUP Weekly Sync" is a genuine client call. A bare "sync"
    // pattern would silently swallow most of the client calls we care about.
    for (const title of [
      'FuseAI <> PIXELUP Weekly Sync',
      'Greptile <> PIXELUP Sync',
      'Acme <> PIXELUP Design Review',
      'Crossword <> PIXELUP Kickoff',
      'Marker <> PIXELUP Weekly',
      // A bare "internal" pattern silently swallowed this — a client whose name
      // merely CONTAINS the word is still a client.
      'Nointernal <> PIXELUP Sync',
    ]) {
      assert.strictEqual(ignoredTitlePattern(title, PATTERNS), null, `should keep: ${title}`);
    }
  });

  it('returns the matching pattern so the skip can be logged', () => {
    assert.strictEqual(ignoredTitlePattern('Daily Stand Up', PATTERNS), 'standup');
  });

  it('is a no-op with no patterns or no title', () => {
    assert.strictEqual(ignoredTitlePattern('Daily Standup', []), null);
    assert.strictEqual(ignoredTitlePattern('Daily Standup', undefined), null);
    assert.strictEqual(ignoredTitlePattern('', PATTERNS), null);
  });
});
