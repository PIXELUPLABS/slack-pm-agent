import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';

import { formatTranscript, isTldvUrl, parseTldvMeetingId, readTldvMeeting } from '../../integrations/tldv.js';

const ID = '507f1f77bcf86cd799439011';

afterEach(() => {
  delete process.env.TLDV_API_KEY;
});

describe('isTldvUrl', () => {
  it('matches tldv.io and its subdomains only', () => {
    assert.strictEqual(isTldvUrl('https://tldv.io/app/meetings/abc'), true);
    assert.strictEqual(isTldvUrl('https://app.tldv.io/meetings/abc'), true);
    // Lookalike hosts must not be treated as tl;dv.
    assert.strictEqual(isTldvUrl('https://tldv.io.evil.com/x'), false);
    assert.strictEqual(isTldvUrl('https://nottldv.io/x'), false);
    assert.strictEqual(isTldvUrl('not a url'), false);
  });
});

describe('parseTldvMeetingId', () => {
  it('pulls the id out of the app URL shapes', () => {
    assert.strictEqual(parseTldvMeetingId(`https://tldv.io/app/meetings/${ID}`), ID);
    assert.strictEqual(parseTldvMeetingId(`https://tldv.io/app/meetings/${ID}?t=125`), ID);
    assert.strictEqual(parseTldvMeetingId(`https://tldv.io/app/meetings/${ID}/transcript#top`), ID);
  });

  it('accepts a bare meeting id', () => {
    assert.strictEqual(parseTldvMeetingId(ID), ID);
    assert.strictEqual(parseTldvMeetingId(`  ${ID}  `), ID);
  });

  it('returns null for non-tldv input', () => {
    assert.strictEqual(parseTldvMeetingId('https://example.com/meetings/123'), null);
    assert.strictEqual(parseTldvMeetingId(''), null);
  });
});

describe('formatTranscript', () => {
  it('renders speaker-attributed, timestamped lines oldest-first', () => {
    const text = formatTranscript({
      data: [
        { speaker: 'Arjun', text: 'Lets start with scope.', startTime: 5 },
        { speaker: 'Client', text: 'We need the brand kit first.', startTime: 72 },
      ],
    });
    assert.strictEqual(text, '[00:05] Arjun: Lets start with scope.\n[01:12] Client: We need the brand kit first.');
  });

  it('caps very long transcripts and says how much was dropped', () => {
    const data = Array.from({ length: 1300 }, (_, i) => ({ speaker: 'A', text: `line ${i}`, startTime: i }));
    const text = formatTranscript({ data });
    assert.match(text, /100 more transcript line\(s\) omitted/);
  });

  it('returns empty for a missing or still-processing transcript', () => {
    assert.strictEqual(formatTranscript(null), '');
    assert.strictEqual(formatTranscript({ data: [] }), '');
  });
});

describe('readTldvMeeting', () => {
  /** @param {Record<string, any>} routes path suffix → JSON body (or a status number) */
  function fakeFetch(routes) {
    return mock.fn(async (/** @type {string} */ url) => {
      const match = Object.keys(routes).find((k) => url.endsWith(k));
      const body = match ? routes[match] : 404;
      if (typeof body === 'number') {
        return { ok: false, status: body, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => body };
    });
  }

  it('combines metadata, notes, and transcript into one readable block', async () => {
    process.env.TLDV_API_KEY = 'k';
    const fetchImpl = fakeFetch({
      [`/meetings/${ID}`]: {
        id: ID,
        name: 'Acme kickoff',
        happenedAt: '2026-07-28T10:00:00Z',
        duration: 1800,
        organizer: { name: 'Arjun', email: 'arjun@pixelup.com' },
        invitees: [{ name: 'Dana', email: 'dana@acme.com' }],
        url: `https://tldv.io/app/meetings/${ID}`,
      },
      [`/meetings/${ID}/transcript`]: { data: [{ speaker: 'Dana', text: 'Launch is Sept 1.', startTime: 30 }] },
      [`/meetings/${ID}/notes`]: { data: [{ content: 'Client wants brand kit first', startTime: 40 }] },
    });

    const text = await readTldvMeeting(ID, { fetchImpl });
    assert.match(text, /Meeting: Acme kickoff/);
    assert.match(text, /Duration: 30 min/);
    assert.match(text, /Participants: Dana <dana@acme\.com>/);
    assert.match(text, /AI notes:\n- \[00:40\] Client wants brand kit first/);
    assert.match(text, /Transcript:\n\[00:30\] Dana: Launch is Sept 1\./);
  });

  it('sends the API key as x-api-key', async () => {
    process.env.TLDV_API_KEY = 'secret-key';
    const fetchImpl = fakeFetch({ [`/meetings/${ID}`]: { id: ID, name: 'M' } });
    await readTldvMeeting(ID, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0].arguments;
    assert.strictEqual(init.headers['x-api-key'], 'secret-key');
  });

  it('still reports the meeting when the transcript is not ready', async () => {
    process.env.TLDV_API_KEY = 'k';
    const fetchImpl = fakeFetch({ [`/meetings/${ID}`]: { id: ID, name: 'Fresh call' } });
    const text = await readTldvMeeting(ID, { fetchImpl });
    assert.match(text, /Fresh call/);
    assert.match(text, /Transcript: not available yet/);
  });

  it('explains a rejected key rather than surfacing a bare 401', async () => {
    process.env.TLDV_API_KEY = 'bad';
    const fetchImpl = fakeFetch({ [`/meetings/${ID}`]: 401 });
    await assert.rejects(() => readTldvMeeting(ID, { fetchImpl }), /rejected the API key/);
  });

  it('reports an unknown meeting id', async () => {
    process.env.TLDV_API_KEY = 'k';
    await assert.rejects(() => readTldvMeeting(ID, { fetchImpl: fakeFetch({}) }), /No tl;dv meeting found/);
  });

  it('refuses without an API key instead of calling out', async () => {
    const fetchImpl = fakeFetch({});
    await assert.rejects(() => readTldvMeeting(ID, { fetchImpl }), /set TLDV_API_KEY/);
    assert.strictEqual(fetchImpl.mock.callCount(), 0);
  });
});
