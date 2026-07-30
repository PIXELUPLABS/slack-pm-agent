/**
 * tl;dv read-only client — meeting metadata, transcript, and AI notes.
 *
 * Fireflies is wired in as an MCP server; tl;dv has no MCP endpoint of its own,
 * so its small REST API is called directly. Reads only: nothing here creates,
 * imports, or deletes a meeting.
 *
 * API: https://pasta.tldv.io/v1alpha1, authenticated with an `x-api-key`
 * header (an API key from tl;dv settings; Pro/Business plans only).
 */

const TLDV_BASE = process.env.TLDV_API_URL || 'https://pasta.tldv.io/v1alpha1';
const TIMEOUT_MS = 20000;
/** Transcript lines to keep. Long calls otherwise flood the context window. */
const MAX_TRANSCRIPT_LINES = 1200;

/** @returns {boolean} */
export function isTldvConfigured() {
  return Boolean(process.env.TLDV_API_KEY);
}

/** @param {string} url @returns {boolean} */
export function isTldvUrl(url) {
  try {
    return /(^|\.)tldv\.io$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Meeting ID out of a tl;dv link. Handles the app URL shapes
 * (`/app/meetings/<id>`, with or without a `?t=` timestamp or extra segments)
 * and accepts a bare ID.
 * @param {string} input
 * @returns {string | null}
 */
export function parseTldvMeetingId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // A bare ID: tl;dv uses 24-char hex ObjectIds.
  if (/^[a-f0-9]{24}$/i.test(raw)) return raw;
  if (!isTldvUrl(raw)) return null;
  const segments = new URL(raw).pathname.split('/').filter(Boolean);
  const afterMeetings = segments.indexOf('meetings');
  if (afterMeetings >= 0 && segments[afterMeetings + 1]) return segments[afterMeetings + 1];
  // Fall back to the last ID-shaped segment.
  const idLike = [...segments].reverse().find((s) => /^[a-zA-Z0-9_-]{8,}$/.test(s));
  return idLike || null;
}

/**
 * @param {string} path
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<any>} Parsed JSON, or null on 404.
 */
async function tldvGet(path, options = {}) {
  const key = process.env.TLDV_API_KEY;
  if (!key) throw new Error('tl;dv is not connected — set TLDV_API_KEY (tl;dv → Settings → API keys).');
  const doFetch = options.fetchImpl || fetch;
  const res = await doFetch(`${TLDV_BASE}${path}`, {
    headers: { 'x-api-key': key, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error('tl;dv rejected the API key (401/403) — check TLDV_API_KEY and that the plan includes API access.');
  }
  if (!res.ok) throw new Error(`tl;dv API error ${res.status}.`);
  return res.json();
}

/**
 * Render transcript segments as speaker-attributed lines.
 * @param {any} transcript Response of GET /meetings/{id}/transcript.
 * @returns {string}
 */
export function formatTranscript(transcript) {
  const segments = Array.isArray(transcript?.data) ? transcript.data : [];
  if (segments.length === 0) return '';
  const kept = segments.slice(0, MAX_TRANSCRIPT_LINES);
  const lines = kept.map((/** @type {any} */ s) => {
    const stamp = Number.isFinite(s.startTime) ? `[${formatClock(s.startTime)}] ` : '';
    return `${stamp}${s.speaker || 'Unknown'}: ${String(s.text || '').trim()}`;
  });
  const dropped = segments.length - kept.length;
  if (dropped > 0) lines.push(`[…${dropped} more transcript line(s) omitted]`);
  return lines.join('\n');
}

/** @param {number} seconds @returns {string} */
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Everything readable about one meeting, as text: metadata, AI notes, then the
 * transcript. Notes and transcript are fetched independently — a meeting still
 * processing has metadata but no transcript yet, and that is reported rather
 * than failing the read.
 * @param {string} meetingId
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string>}
 */
export async function readTldvMeeting(meetingId, options = {}) {
  const meeting = await tldvGet(`/meetings/${encodeURIComponent(meetingId)}`, options);
  if (!meeting) throw new Error(`No tl;dv meeting found with id ${meetingId}.`);

  const [transcript, notes] = await Promise.all([
    tldvGet(`/meetings/${encodeURIComponent(meetingId)}/transcript`, options).catch(() => null),
    tldvGet(`/meetings/${encodeURIComponent(meetingId)}/notes`, options).catch(() => null),
  ]);

  const header = [
    `Meeting: ${meeting.name || '(untitled)'}`,
    meeting.happenedAt ? `Date: ${meeting.happenedAt}` : '',
    Number.isFinite(meeting.duration) ? `Duration: ${Math.round(meeting.duration / 60)} min` : '',
    meeting.organizer?.email ? `Organizer: ${meeting.organizer.name || ''} <${meeting.organizer.email}>` : '',
    formatInvitees(meeting.invitees),
    meeting.url ? `Link: ${meeting.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const noteText = formatNotes(notes);
  const transcriptText = formatTranscript(transcript);

  return [
    header,
    noteText ? `\nAI notes:\n${noteText}` : '',
    transcriptText
      ? `\nTranscript:\n${transcriptText}`
      : '\nTranscript: not available yet (tl;dv may still be processing this recording).',
  ]
    .filter(Boolean)
    .join('\n');
}

/** @param {any[]} invitees @returns {string} */
function formatInvitees(invitees) {
  const list = (Array.isArray(invitees) ? invitees : [])
    .map((i) => `${i.name || ''}${i.email ? ` <${i.email}>` : ''}`.trim())
    .filter(Boolean);
  return list.length > 0 ? `Participants: ${list.join(', ')}` : '';
}

/**
 * The notes payload shape varies by template, so this handles a plain string,
 * a `{ data: [...] }` list, and note objects with a `content`/`text` field.
 * @param {any} notes
 * @returns {string}
 */
function formatNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes.trim();
  const items = Array.isArray(notes) ? notes : Array.isArray(notes.data) ? notes.data : [];
  return items
    .map((/** @type {any} */ n) => {
      if (typeof n === 'string') return `- ${n}`;
      const body = n.content ?? n.text ?? n.note ?? '';
      const stamp = Number.isFinite(n.startTime) ? `[${formatClock(n.startTime)}] ` : '';
      return body ? `- ${stamp}${String(body).trim()}` : '';
    })
    .filter(Boolean)
    .join('\n');
}
