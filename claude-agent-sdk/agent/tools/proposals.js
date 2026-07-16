import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { buildApprovalCard } from '../../approvals/card-builder.js';
import { buildRegistration } from '../../approvals/registration.js';
import {
  applyDueDatePriorities,
  resolveStage,
  snapDueDateToWeekday,
  snapStartDateToWeekday,
} from '../../approvals/scaffold-rules.js';
import { proposalStore } from '../../approvals/store.js';
import { isClientChannel, isLead } from '../../config/index.js';
import * as clickupMcp from '../../integrations/clickup-mcp.js';

/** @param {string} text @returns {{ content: [{ type: 'text', text: string }] }} */
function asResult(text) {
  return { content: [{ type: 'text', text }] };
}

/**
 * Proposal tools — the ONLY way the agent expresses a write. Each tool stores
 * structured JSON and posts a Block Kit approval card; deterministic code in
 * approvals/executor.js runs it after a human approves. The agent never
 * writes directly.
 * @param {{ client: import('@slack/web-api').WebClient, userId: string, channelId: string, threadTs: string }} deps
 * @param {import('../../config/index.js').Conventions} conventions
 * @returns {any[]}
 */
export function createProposalTools(deps, conventions) {
  /**
   * @param {import('../../approvals/store.js').ProposalType} type
   * @param {any} payload
   * @param {string} [clientKey]
   * @param {string} [targetChannelId] - Defaults to the current thread.
   * @returns {Promise<{ content: [{ type: 'text', text: string }] }>}
   */
  async function postProposal(type, payload, clientKey, targetChannelId) {
    const channel = targetChannelId || deps.channelId;
    // Hard rule: no bot messages in client channels — refuse in code even if
    // something upstream slipped through.
    if (isClientChannel(conventions, channel)) {
      return asResult('Refused: approval cards can never be posted in client channels.');
    }
    if (clientKey && !conventions.clients[clientKey]) {
      return asResult(`Unknown client "${clientKey}". Known: ${Object.keys(conventions.clients).join(', ')}`);
    }
    const proposal = proposalStore.create({ type, payload, requesterId: deps.userId, clientKey });
    const posted = await deps.client.chat.postMessage({
      channel,
      ...(channel === deps.channelId && { thread_ts: deps.threadTs }),
      text: 'Proposal awaiting approval',
      blocks: buildApprovalCard(proposal),
    });
    proposalStore.attachMessage(proposal.id, /** @type {string} */ (posted.channel), /** @type {string} */ (posted.ts));
    return asResult(`Proposal posted for approval (id ${proposal.id}). Nothing is written until it is approved.`);
  }

  const taskSchema = {
    client_key: z.string().describe('Client key from conventions.'),
    title: z.string().max(120),
    description: z.string().optional(),
    priority: z.string().optional().describe('Priority name from conventions.'),
    due_date: z.string().optional().describe('YYYY-MM-DD'),
    assignee_slack_id: z.string().optional(),
    source_quote: z.string().optional().describe('Verbatim client message this task is based on.'),
  };

  const proposeTask = tool(
    'propose_task',
    'Propose one ClickUp task for approval. Always include source_quote when the task comes from a client message.',
    taskSchema,
    ({ client_key, title, description, priority, due_date, assignee_slack_id, source_quote }) =>
      postProposal(
        'task',
        {
          clientKey: client_key,
          title,
          description,
          priority,
          dueDate: snapDueDateToWeekday(due_date),
          assigneeSlackId: assignee_slack_id,
          assigneeName: assignee_slack_id ? conventions.users[assignee_slack_id]?.name : undefined,
          sourceQuote: source_quote,
        },
        client_key,
      ),
  );

  const proposeTaskUpdate = tool(
    'propose_task_update',
    'Propose changes to an existing ClickUp task (name, description, priority, due_date, status).',
    {
      task_id: z.string(),
      fields: z
        .record(z.string(), z.string())
        .describe(
          'Field → new value. Allowed: name, description, priority, start_date, due_date (YYYY-MM-DD), status.',
        ),
    },
    ({ task_id, fields }) => {
      // Weekend dates snap per the agency calendar rule before the card renders.
      const adjusted = { ...fields };
      if (adjusted.due_date) adjusted.due_date = /** @type {string} */ (snapDueDateToWeekday(adjusted.due_date));
      if (adjusted.start_date) {
        adjusted.start_date = /** @type {string} */ (snapStartDateToWeekday(adjusted.start_date));
      }
      return postProposal('task_update', { taskId: task_id, fields: adjusted });
    },
  );

  const proposeQaTasks = tool(
    'propose_qa_tasks',
    'Propose a deduped batch of QA tasks from a QA thread. One approval creates all of them in the QA list.',
    {
      client_key: z.string(),
      tasks: z
        .array(
          z.object({
            title: z.string(),
            page: z.string().optional(),
            device: z.string().optional(),
            severity: z.string().optional().describe('Priority name from conventions.'),
            description: z.string().optional(),
          }),
        )
        .min(1),
    },
    ({ client_key, tasks }) => {
      // No QA list mapped → don't propose; instruct the human workflow instead
      // (a lead duplicates the demo QA board in ClickUp, config gets the ID).
      const clientConfig = conventions.clients[client_key];
      if (clientConfig && !clientConfig.qa_list_id) {
        return Promise.resolve(
          asResult(
            `${clientConfig.display_name} has no QA list yet. Ask a lead to duplicate the "QA Board Demo" list ` +
              `(demo project folder in ClickUp) into the ${clientConfig.display_name} folder — duplicating keeps the ` +
              'QA statuses (reported → in dev fix → …). Then add the new list ID as qa_list_id in ' +
              'config/conventions.json and restart the bot. Once that is done, ask me again and I will create the tasks.',
          ),
        );
      }
      return postProposal('qa_tasks', { clientKey: client_key, tasks }, client_key);
    },
  );

  const proposeScaffold = tool(
    'propose_project_scaffold',
    "Propose the milestone tasks for a new engagement, added to the client's EXISTING engagement list (client folders are duplicated from the demo template, so the list already exists). Leads only.",
    {
      client_key: z.string(),
      tasks: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            start_date: z.string().optional().describe('YYYY-MM-DD — when work on the milestone begins.'),
            due_date: z.string().optional().describe('YYYY-MM-DD'),
            stage: z.string().optional().describe('Project Stage group: planning, visual design, content, dev, or qa.'),
            blocked_by: z
              .array(z.string())
              .optional()
              .describe('Titles of OTHER tasks in this scaffold that must finish first.'),
            assignee_slack_ids: z.array(z.string()).optional().describe('Slack IDs from the team list.'),
          }),
        )
        .min(1),
    },
    ({ client_key, tasks }) => {
      // Permission gate lives in code (config role), not in the prompt.
      if (!isLead(conventions, deps.userId)) {
        return Promise.resolve(asResult('Only leads can trigger project scaffolding.'));
      }
      const titles = new Set(tasks.map((t) => t.title));
      const tasks2 = tasks.map((t) => {
        const stage = resolveStage(conventions, t.stage);
        return {
          title: t.title,
          description: t.description,
          startDate: snapStartDateToWeekday(t.start_date),
          dueDate: snapDueDateToWeekday(t.due_date),
          stageName: stage?.name,
          stageOptionId: stage?.optionId,
          // Only dependencies that reference tasks in this same scaffold.
          blockedBy: (t.blocked_by || []).filter((title) => titles.has(title) && title !== t.title),
          assigneeSlackIds: t.assignee_slack_ids,
          assigneeNames: (t.assignee_slack_ids || []).map((id) => conventions.users[id]?.name).filter(Boolean),
        };
      });
      // Priorities are a deterministic agency rule (closest due date urgent,
      // second high, rest low) — applied in code, not model judgment.
      applyDueDatePriorities(tasks2);
      return postProposal('scaffold', { clientKey: client_key, tasks: tasks2 }, client_key);
    },
  );

  const proposeClientUpdate = tool(
    'propose_client_update',
    'Propose a client update draft. Posts to the internal drafts channel for sign-off; a human sends it. Leads only.',
    {
      client_key: z.string(),
      draft: z.string().describe('The full update text, written in the agency voice.'),
    },
    ({ client_key, draft }) => {
      if (!isLead(conventions, deps.userId)) {
        return Promise.resolve(asResult('Only leads can trigger client-facing drafts.'));
      }
      const draftsChannel = conventions.channels.drafts_channel_id || undefined;
      return postProposal('client_update', { clientKey: client_key, draft }, client_key, draftsChannel);
    },
  );

  const proposeClientRegistration = tool(
    'propose_client_registration',
    'Register a new client: code finds their ClickUp folder/lists and Slack channels ({key}-pixelup, {key}-internal) and proposes the config entry. Leads only.',
    {
      client_name: z.string().describe('Client name matching their ClickUp folder, e.g. "Marker".'),
    },
    async ({ client_name }) => {
      // Permission gate lives in code (config role), not in the prompt.
      if (!isLead(conventions, deps.userId)) {
        return asResult('Only leads can register clients.');
      }
      try {
        const { clientKey, entry, notes } = await buildRegistration({
          clientName: client_name,
          slackClient: deps.client,
          clickup: clickupMcp,
        });
        if (conventions.clients[clientKey]) {
          return asResult(`Client "${clientKey}" is already registered.`);
        }
        return postProposal('client_registration', { clientKey, entry, notes });
      } catch (e) {
        return asResult(/** @type {Error} */ (e).message);
      }
    },
  );

  return [
    proposeTask,
    proposeTaskUpdate,
    proposeQaTasks,
    proposeScaffold,
    proposeClientUpdate,
    proposeClientRegistration,
  ];
}
