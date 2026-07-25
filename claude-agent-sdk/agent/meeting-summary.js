import { query } from '@anthropic-ai/claude-agent-sdk';

import { loadConventions } from '../config/index.js';

/**
 * Concise internal meeting recap. This is deliberately NOT the full Pixelup
 * agent: it attaches no MCP servers and no tools, runs a single turn, and only
 * transforms the Fireflies transcript text into a short, to-do-focused recap in
 * the agency voice. It never reads or writes anything — the listener decides
 * where the result goes (an internal channel only, never a client channel).
 */

// Cap what flows into the model — Fireflies notes are long and we only need a
// concise recap. Keeps the run cheap.
const MAX_NOTES_CHARS = 9000;

// Pinned per the hard rules in CLAUDE.md (model is set in code). A simple
// summarize could route to Haiku later; sonnet stays the safe default.
const MODEL = 'claude-sonnet-5';

/**
 * @param {string} voice
 * @returns {string}
 */
function buildSystemPrompt(voice) {
  return `You are Pixelup Bot writing a CONCISE internal recap of a CLIENT meeting for the Pixelup Labs \
project team. This lands in an internal team channel — it is never seen by the client.

Focus on what the team needs to act on: the DECISIONS made and the NEXT TO-DOS agreed in the meeting. \
Be scannable and short.

Agency voice: ${voice}

Output Slack mrkdwn only (use *bold*, and "• " for bullets — no "#" headings, no tables). Structure:
- First line: *{Client} — {meeting title}* recap.
- *Decisions* — 2–5 bullets, only if clear decisions were made.
- *Next to-dos* — the action items, grouped by owner where an owner is named ("*Name:* action"), each a crisp next step.
Keep the whole thing under ~200 words. No preamble, no sign-off, at most one emoji.`;
}

/**
 * Produce the recap text. Reads nothing and posts nothing.
 * @param {{ displayName: string, title: string, headerText: string, notesText: string }} meeting
 * @param {{ conventions?: import('../config/index.js').Conventions, query?: typeof query }} [options]
 * @returns {Promise<string>}
 */
export async function summarizeMeeting(meeting, options = {}) {
  const conventions = options.conventions || loadConventions();
  const queryFn = options.query || query;
  const voice = conventions.agency.voice;
  const notes = (meeting.notesText || '').slice(0, MAX_NOTES_CHARS);

  const prompt =
    `Client: ${meeting.displayName}\n` +
    `Meeting: ${meeting.title}\n\n` +
    `--- Meeting header ---\n${meeting.headerText}\n\n` +
    `--- Notes & action items ---\n${notes}\n\n` +
    'Write the concise internal recap now.';

  /** @type {string[]} */
  const parts = [];
  for await (const message of queryFn({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: buildSystemPrompt(voice),
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
    },
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}
