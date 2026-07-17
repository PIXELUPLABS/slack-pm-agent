import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { conventionsSummary, loadConventions } from '../config/index.js';
import { agentServerConfig, CLICKUP_MCP, FIREFLIES_MCP } from '../integrations/mcp-servers.js';
import { createProposalTools, createSlackReadTools } from './tools/index.js';

const BASE_SYSTEM_PROMPT = `\
You are Pixelup Bot, the internal project-management assistant for Pixelup Labs, a design \
agency. You handle the repetitive PM work between Slack, ClickUp, and Fireflies so designers \
stay on design. You are concise, professional, and efficient.

## HOW YOU WORK
- You PROPOSE writes; you never execute them. Every ClickUp write goes through a propose_* \
tool, which posts an approval card. Deterministic code executes it after a human approves.
- Your run ENDS when you reply. Approvals happen after you are gone, and nothing runs \
automatically afterwards — NEVER promise that a follow-up will happen "automatically once \
approved". When work depends on an approval (e.g. scaffold after registration), end with: \
"Approve the card, then ask me to continue and I'll propose the next step."
- Reads are direct and safe: ClickUp MCP tools for tasks/lists, Fireflies MCP tools for \
meeting summaries, and the Slack read tools for channels, threads, and shared files.
- Quote the exact client message a task is based on (source_quote) so nothing gets misread.
- Follow the conventions below — client keys, priorities, naming, team IDs. Never invent \
IDs or data; only reference what tools return.
- Be token-frugal: call only the tools you need, once each where possible. Prefer summaries \
over full transcripts or full task dumps.
- Batch related ClickUp changes into ONE proposal: propose_task_update takes many tasks in \
one call (one card, one tap) — never post a separate card per task in a bulk change.
- Custom fields (e.g. Project Stage) are omitted from clickup_get_task unless you pass \
include: ["custom_fields"], and clickup_filter_tasks can neither filter by them nor return \
them. To see stages across a list, get_task the specific tasks you care about.

## WORKFLOWS
1. **Client task intake** — user asks to capture a client request: read the client channel \
to find the message, then propose_task with title, priority, due date, stage, and the \
verbatim quote. Always set stage (planning, visual design, content, dev, or qa) — it is the \
board group the task lands in; infer it from the task type (design work → visual design, \
implementation → dev, copy → content).
2. **Client onboarding** — user shares an engagement doc: read it (read_shared_file), \
cross-check the Fireflies kickoff transcript for verbal agreements the doc misses, read the \
client's existing engagement list (it is duplicated from the demo template and may already \
hold starter tasks), then propose_project_scaffold with the MISSING milestone tasks \
(phases, not micro-tasks). Never re-propose a milestone that already exists in the list. \
For each task set: start_date (when the phase begins) AND due_date from the doc's \
week-by-week timeline table, a stage, and blocked_by with the titles of milestones that \
must genuinely finish first (e.g. Development is blocked by design sign-off; parallel \
phases are not blocked by each other).
3. **QA rounds** — tagged in a QA thread: read the thread, dedupe comments, structure them \
(page, device, severity), then propose_qa_tasks as one batch. QA tasks start at "reported".
4. **Client updates** — draft the week's update from ClickUp activity and internal channel \
context in the agency voice, then propose_client_update (it lands in the internal drafts \
channel for sign-off).
5. **Queries** — "what's on my plate", "status of X": answer from ClickUp MCP read tools, \
filtering by the requester's ClickUp ID from the conventions.
6. **Register a client** — a lead asks to register a new client (their ClickUp folder and \
Slack channels already exist): call propose_client_registration with the client name; code \
locates the folder, lists, and channels and posts the config entry for approval. After \
approval the client is usable immediately.

## TEAM CONVENTIONS
- Every user message is prefixed with "[From <@SLACK_ID>]" — that is the requester. Resolve \
who they are (name, role, ClickUp ID) from the Team list below; never ask who is asking.
- Slack channels per client: "{key}-pixelup" is the EXTERNAL client channel (never post \
there); "{key}-internal" is the internal one.
- Weeks run Monday–Friday: "end of week N" always means that week's FRIDAY. Never put a \
due date on a weekend (code snaps Sat/Sun due dates back to Friday, start dates forward to \
Monday).
- Daily standups in Slack use this shape: "Items | {Client}: P{0-3} | ETA: {time}" followed \
by bullet points, one block per client. P0=urgent, P1=high, P2=normal, P3=low. When reading \
standups or capturing tasks from them, map P-levels to priorities accordingly.
- Task names are short and milestone-level ("Logo Concepts", "Web Design") — no client \
prefix; the client is implied by the list the task lives in.

## RESPONSE STYLE
- Short, scannable, actionable. End with the clear next step on its own line.
- Standard Markdown; use \`inline code\` for task IDs, list names, and project names.
- At most one emoji per message.

## EMOJI REACTIONS
React to each user message with \`add_emoji_reaction\` before responding — pick an emoji \
matching the topic or tone, vary across a thread, never \`eyes\` (automatic). Call \
\`mark_resolved\` once when a request is fully handled.

## BOUNDARIES (never violate)
- You never interact with clients and never post in client channels — no exceptions. \
Your access to client channels is READ-ONLY (for finding client requests); you converse \
only in DMs and internal channels. Drafts for clients are always routed through the \
internal drafts channel for a human to send.
- You never execute writes yourself and you have no delete capability. Your ClickUp and \
Fireflies access is read-only; writes happen only through approved proposals.
- Only leads can trigger client-facing drafts or project scaffolding; the code enforces \
this — if a tool refuses, relay that politely.
- Redirect requests outside PM and agency operations. Pure Slack summarization (thread \
recaps) is the built-in Slackbot's job — point people there to keep costs down.
- If a request is ambiguous, ask one clarifying question instead of guessing.`;

// The system prompt stays byte-identical across runs (maximum prompt-cache
// hits) and only changes when the conventions actually change — e.g. after an
// approved client registration hot-reloads the config.
/** @type {{ summary: string | null, prompt: string }} */
let promptCache = { summary: null, prompt: '' };

/** @param {import('../config/index.js').Conventions} conventions @returns {string} */
function systemPromptFor(conventions) {
  const summary = conventionsSummary(conventions);
  if (promptCache.summary !== summary) {
    promptCache = { summary, prompt: `${BASE_SYSTEM_PROMPT}\n\n## CONVENTIONS\n${summary}` };
  }
  return promptCache.prompt;
}

const EMOJI_DESCRIPTION =
  "Add one emoji reaction to the user's current message. Any Slack emoji matching the topic or tone " +
  '(e.g. art for design, memo for task capture, tada for wins). Not eyes (automatic) or white_check_mark (reserved).';

/**
 * Local tools (SDK MCP server 'pixelup-tools'). Bare names are included
 * alongside prefixed ones for compatibility across SDK versions.
 * @type {string[]}
 */
const LOCAL_TOOLS = [
  'add_emoji_reaction',
  'mark_resolved',
  'propose_client_registration',
  'propose_client_update',
  'propose_project_scaffold',
  'propose_qa_tasks',
  'propose_task',
  'propose_task_update',
  'read_channel_messages',
  'read_shared_file',
  'read_slack_thread',
];

/**
 * READ-ONLY allowlists for the external MCP servers. Deliberately no
 * wildcards: anything not named here — every create/update/delete/send tool
 * those servers expose — is unavailable to the agent. Writes only happen via
 * the approval executor. Names verified against the live servers on
 * 2026-07-13 (tools/list via `npm run auth:*`).
 * @type {string[]}
 */
const CLICKUP_READ_TOOLS = [
  'clickup_filter_tasks',
  'clickup_find_member_by_name',
  'clickup_get_folder',
  'clickup_get_list',
  'clickup_get_task',
  'clickup_get_task_comments',
  'clickup_get_workspace_hierarchy',
  'clickup_get_workspace_members',
  'clickup_resolve_assignees',
  'clickup_search',
];

/** @type {string[]} */
const FIREFLIES_READ_TOOLS = [
  'fireflies_get_summary',
  'fireflies_get_transcript',
  'fireflies_get_transcripts',
  'fireflies_search',
];

/** @returns {string[]} */
function buildAllowedTools() {
  return [
    ...LOCAL_TOOLS,
    ...LOCAL_TOOLS.map((name) => `mcp__pixelup-tools__${name}`),
    ...CLICKUP_READ_TOOLS.map((name) => `mcp__${CLICKUP_MCP.key}__${name}`),
    ...FIREFLIES_READ_TOOLS.map((name) => `mcp__${FIREFLIES_MCP.key}__${name}`),
  ];
}

// Bound the agentic loop so a runaway conversation can't burn tokens.
const MAX_TURNS = 16;

const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

/**
 * @typedef {Object} PixelupDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 */

/**
 * Run the Pixelup agent with the given text and optional session ID.
 * @param {string} text - The user's message text.
 * @param {string} [sessionId] - An existing session ID to resume conversation.
 * @param {PixelupDeps} [deps] - Dependencies for tools that need Slack API access.
 * @returns {Promise<{responseText: string, sessionId: string | null}>}
 */
export async function runPixelupAgent(text, sessionId = undefined, deps = undefined) {
  const conventions = loadConventions();

  // Closure-based tools that need deps for Slack API access
  const addEmojiReactionTool = tool(
    'add_emoji_reaction',
    EMOJI_DESCRIPTION,
    { emoji_name: z.string().describe("The Slack emoji name without colons (e.g. 'tada', 'memo', 'art').") },
    async ({ emoji_name }) => {
      if (!deps) {
        return { content: [{ type: 'text', text: 'No deps available to add reaction.' }] };
      }

      // Skip ~15% of reactions to feel more natural
      if (Math.random() < 0.15) {
        return {
          content: [
            { type: 'text', text: `Skipped :${emoji_name}: reaction (randomly omitted to avoid over-reacting)` },
          ],
        };
      }

      try {
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.messageTs,
          name: emoji_name,
        });
        return { content: [{ type: 'text', text: `Reacted with :${emoji_name}:` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Could not add reaction: ${err.data?.error || err.message}` }] };
      }
    },
  );

  const markResolvedTool = tool(
    'mark_resolved',
    "Mark the user's request as resolved by adding a green check mark reaction to the parent thread message. " +
      'Call this once when the request is fully handled — proposal posted, question answered, draft delivered.',
    {},
    async () => {
      if (!deps) {
        return { content: [{ type: 'text', text: 'No deps available to mark resolved.' }] };
      }

      try {
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.threadTs,
          name: 'white_check_mark',
        });
        return { content: [{ type: 'text', text: 'Thread marked as resolved.' }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Could not mark resolved: ${err.data?.error || err.message}` }] };
      }
    },
  );

  /** @type {any[]} */
  const tools = [addEmojiReactionTool, markResolvedTool];
  if (deps) {
    tools.push(...createSlackReadTools(deps, conventions), ...createProposalTools(deps, conventions));
  }

  const pixelupToolsServer = createSdkMcpServer({
    name: 'pixelup-tools',
    version: '1.0.0',
    tools,
  });

  /** @type {Record<string, any>} */
  const mcpServers = { 'pixelup-tools': pixelupToolsServer };

  // External MCP servers attach only when authorized (OAuth store or static
  // token), and only their read tools are allowlisted below.
  const [clickupServer, firefliesServer] = await Promise.all([
    agentServerConfig(CLICKUP_MCP),
    agentServerConfig(FIREFLIES_MCP),
  ]);
  if (clickupServer) mcpServers[CLICKUP_MCP.key] = clickupServer;
  if (firefliesServer) mcpServers[FIREFLIES_MCP.key] = firefliesServer;

  const allowedTools = buildAllowedTools();

  if (deps?.userToken) {
    mcpServers['slack-mcp'] = {
      type: 'http',
      url: SLACK_MCP_URL,
      headers: { Authorization: `Bearer ${deps.userToken}` },
    };
    allowedTools.push('mcp__slack-mcp__*');
  }

  /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
  const options = {
    // Pinned per the hard rules in CLAUDE.md; simple parsing tasks may route
    // to Haiku later.
    model: 'claude-sonnet-5',
    systemPrompt: systemPromptFor(conventions),
    mcpServers,
    allowedTools,
    maxTurns: MAX_TURNS,
    // 'default' (not 'bypassPermissions'): tools outside allowedTools — every
    // ClickUp/Fireflies write and delete tool — are denied, in code.
    permissionMode: 'default',
    ...(sessionId && { resume: sessionId }),
  };

  // Identify the requester to the model. This rides on the user message (never
  // the system prompt, which must stay byte-stable for prompt caching).
  const promptText = deps?.userId ? `[From <@${deps.userId}>]\n${text}` : text;

  const responseParts = [];
  let newSessionId = null;

  for await (const message of query({ prompt: promptText, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseParts.push(block.text);
        }
      }
    }
    if (message.type === 'result') {
      newSessionId = message.session_id;
      // Prompt-cache health check: after the first turn, cache_read should
      // dominate and uncached input should stay small. A persistent 0 for
      // cache_read means something is silently invalidating the prefix.
      const usage = /** @type {any} */ (message).usage;
      if (usage) {
        console.log(
          `[pixelup-agent] tokens — uncached_in=${usage.input_tokens ?? 0} ` +
            `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
            `out=${usage.output_tokens ?? 0} cost=$${(/** @type {any} */ (message).total_cost_usd ?? 0).toFixed(4)}`,
        );
      }
    }
  }

  const responseText = responseParts.join('\n');
  return { responseText, sessionId: newSessionId };
}
