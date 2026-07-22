import {
  addClientToConventions,
  formatTaskName,
  getClickUpUserId,
  isKnownPriority,
  knownStatuses,
  resolvePriority,
  resolveStatus,
} from '../config/index.js';
import * as clickupDefault from '../integrations/clickup-mcp.js';
import { resolveStage } from './scaffold-rules.js';

/**
 * Deterministic proposal executor. This is the ONLY code path that writes to
 * ClickUp — the agent proposes, a human approves, this executes by calling
 * the ClickUp MCP server as a client. There is no delete branch and the
 * ClickUp MCP module exposes no delete call.
 */

/**
 * Fields the executor will pass through on a task update. Anything else is
 * dropped. Assignees are deliberately NOT here — they arrive as Slack IDs on
 * `update.assigneeSlackIds` and are resolved to ClickUp user IDs below, so the
 * agent can never smuggle a raw numeric ID through the free-form field map.
 */
const UPDATABLE_FIELDS = ['name', 'description', 'priority', 'start_date', 'due_date', 'status', 'stage'];

/**
 * @param {import('../config/index.js').Conventions} conventions
 * @param {string | undefined} clientKey
 * @returns {import('../config/index.js').ClientConfig}
 */
function requireClient(conventions, clientKey) {
  const client = clientKey ? conventions.clients[clientKey] : undefined;
  if (!client) throw new Error(`Unknown client "${clientKey}" — check config/conventions.json.`);
  return client;
}

/**
 * @param {string | undefined} dueDate - ISO date (YYYY-MM-DD) or undefined.
 * @returns {number | undefined} Unix ms timestamp.
 */
function parseDueDate(dueDate) {
  if (!dueDate) return undefined;
  const ms = Date.parse(dueDate);
  if (Number.isNaN(ms)) throw new Error(`Invalid due date "${dueDate}" — expected YYYY-MM-DD.`);
  return ms;
}

/**
 * Execute an approved proposal.
 * @param {import('./store.js').Proposal} proposal
 * @param {import('../config/index.js').Conventions} conventions
 * @param {typeof clickupDefault} [clickup] - Injectable for tests.
 * @returns {Promise<{ summary: string }>}
 */
export async function executeProposal(proposal, conventions, clickup = clickupDefault) {
  const p = proposal.payload;

  switch (proposal.type) {
    case 'task': {
      const client = requireClient(conventions, p.clientKey);
      if (!isKnownPriority(conventions, p.priority)) {
        throw new Error(
          `Unknown priority "${p.priority}" — valid: ${Object.keys(conventions.clickup.priorities).join(', ')}.`,
        );
      }
      // Accept a list of assignees; tolerate the legacy singular field on any
      // older stored proposals.
      const assigneeSlackIds = p.assigneeSlackIds || (p.assigneeSlackId ? [p.assigneeSlackId] : []);
      const assignees = assigneeSlackIds
        .map((/** @type {string} */ slackId) => getClickUpUserId(conventions, slackId))
        .filter((/** @type {number | null} */ id) => id !== null);
      const stageFieldId = conventions.clickup.project_stage_field?.id;
      const task = await clickup.createTask(client.list_id, {
        name: formatTaskName(conventions, p.clientKey, p.title),
        description: [p.description, p.sourceQuote ? `Source (Slack):\n${p.sourceQuote}` : '']
          .filter(Boolean)
          .join('\n\n'),
        priority: resolvePriority(conventions, p.priority),
        due_date: parseDueDate(p.dueDate),
        assignees: assignees.length > 0 ? /** @type {number[]} */ (assignees) : undefined,
        status: conventions.clickup.default_status,
        parent: p.parentTaskId || undefined,
        tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags : undefined,
        time_estimate: p.timeEstimateMinutes,
        // Project Stage drives the board grouping in the template lists.
        custom_fields: stageFieldId && p.stageOptionId ? [{ id: stageFieldId, value: p.stageOptionId }] : undefined,
      });
      return { summary: `Task created: ${task.url ? `<${task.url}|${task.name}>` : task.name}` };
    }

    case 'task_move': {
      const client = requireClient(conventions, p.destClientKey);
      const toQa = Boolean(p.toQa);
      const listId = toQa ? client.qa_list_id : client.list_id;
      if (!listId) {
        throw new Error(
          toQa
            ? `${p.destClientKey} has no QA list mapped — set qa_list_id in config/conventions.json.`
            : `${p.destClientKey} has no engagement list mapped — check config/conventions.json.`,
        );
      }
      await clickup.moveTask(p.taskId, listId);
      const label = p.taskName || p.taskId;
      return { summary: `Task moved: \`${label}\` → *${client.display_name}*'s ${toQa ? 'QA' : 'engagement'} list.` };
    }

    case 'task_update': {
      // Batch payload ({ updates: [...] }); single-task legacy shape normalizes to a one-entry batch.
      const updates = p.updates || [{ taskId: p.taskId, fields: p.fields }];
      const results = [];
      for (const update of updates) {
        /** @type {Record<string, any>} */
        const fields = {};
        for (const [key, value] of Object.entries(update.fields || {})) {
          if (!UPDATABLE_FIELDS.includes(key)) continue;
          if (key === 'priority') {
            if (!isKnownPriority(conventions, String(value))) {
              throw new Error(
                `Unknown priority "${value}" for task ${update.taskId} — valid: ${Object.keys(conventions.clickup.priorities).join(', ')}.`,
              );
            }
            fields.priority = resolvePriority(conventions, String(value));
          } else if (key === 'due_date' || key === 'start_date') fields[key] = parseDueDate(String(value));
          else if (key === 'stage') {
            // Stage is the Project Stage dropdown custom field, not a native field.
            const stage = resolveStage(conventions, String(value));
            const stageFieldId = conventions.clickup.project_stage_field?.id;
            if (!stage || !stageFieldId) throw new Error(`Unknown stage "${value}" — check config/conventions.json.`);
            fields.custom_fields = [{ id: stageFieldId, value: stage.optionId }];
          } else if (key === 'status') {
            // Reject unknown statuses here so a bad value fails before the card,
            // not as an opaque ClickUp error after someone approves it.
            const status = resolveStatus(conventions, String(value));
            if (!status) {
              throw new Error(
                `Unknown status "${value}" for task ${update.taskId} — valid: ${knownStatuses(conventions).join(', ')}.`,
              );
            }
            fields.status = status;
          } else fields[key] = value;
        }
        // Reassignment: `unassign` clears everyone; otherwise resolve Slack IDs
        // → ClickUp numeric IDs. The MCP update tool takes a flat `assignees`
        // array (arg shape verified live) and sets the task's assignees to it.
        if (update.unassign) {
          fields.clear_assignees = true;
        } else if (Array.isArray(update.assigneeSlackIds) && update.assigneeSlackIds.length > 0) {
          const ids = update.assigneeSlackIds
            .map((/** @type {string} */ slackId) => getClickUpUserId(conventions, slackId))
            .filter((/** @type {number | null} */ id) => id !== null);
          if (ids.length === 0) {
            throw new Error(
              `None of the requested assignees for task ${update.taskId} are in the team mapping — check config/conventions.json.`,
            );
          }
          fields.assignees = /** @type {number[]} */ (ids);
        }
        if (Object.keys(fields).length === 0) {
          throw new Error(`No updatable fields for task ${update.taskId} in this proposal.`);
        }
        const task = await clickup.updateTask(update.taskId, fields);
        const label = update.taskName || task.name;
        results.push(task.url ? `<${task.url}|${label}>` : label);
      }
      return {
        summary:
          results.length === 1
            ? `Task updated: ${results[0]}`
            : `${results.length} task(s) updated:\n${results.map((r) => `• ${r}`).join('\n')}`,
      };
    }

    case 'qa_tasks': {
      const client = requireClient(conventions, p.clientKey);
      const links = [];
      if (!client.qa_list_id) {
        throw new Error(
          `${p.clientKey} has no QA list mapped — duplicate "QA Board Demo" into the client's folder in ClickUp, ` +
            'set qa_list_id in config/conventions.json, restart, and re-propose.',
        );
      }
      for (const item of p.tasks || []) {
        const prefix = [item.page, item.device].filter(Boolean).join(' / ');
        const task = await clickup.createTask(client.qa_list_id, {
          name: prefix ? `[${prefix}] ${item.title}` : item.title,
          description: item.description || '',
          priority: resolvePriority(conventions, item.severity),
          // QA lists have their own pipeline (reported → in dev fix → …).
          status: conventions.clickup.qa_default_status || conventions.clickup.default_status,
        });
        links.push(`• ${task.url ? `<${task.url}|${task.name}>` : task.name}`);
      }
      if (links.length === 0) throw new Error('No QA tasks in this proposal.');
      return { summary: `${links.length} QA task(s) created:\n${links.join('\n')}` };
    }

    case 'scaffold': {
      const client = requireClient(conventions, p.clientKey);
      if (!p.tasks?.length) throw new Error('No tasks in this scaffold proposal.');
      // Client folders are duplicated from the demo template, so the
      // engagement list already exists — populate it, never create lists.
      const stageFieldId = conventions.clickup.project_stage_field?.id;
      const links = [];
      /** @type {Map<string, string>} title → created task ID, for dependency wiring. */
      const createdIds = new Map();
      for (const taskSpec of p.tasks) {
        const assignees = (taskSpec.assigneeSlackIds || [])
          .map((/** @type {string} */ slackId) => getClickUpUserId(conventions, slackId))
          .filter((/** @type {number | null} */ id) => id !== null);
        const task = await clickup.createTask(client.list_id, {
          name: taskSpec.title,
          description: taskSpec.description || '',
          priority: resolvePriority(conventions, taskSpec.priority),
          start_date: parseDueDate(taskSpec.startDate),
          due_date: parseDueDate(taskSpec.dueDate),
          assignees: assignees.length > 0 ? /** @type {number[]} */ (assignees) : undefined,
          status: conventions.clickup.default_status,
          // Project Stage drives the board grouping in the template lists.
          custom_fields:
            stageFieldId && taskSpec.stageOptionId ? [{ id: stageFieldId, value: taskSpec.stageOptionId }] : undefined,
        });
        if (task.id) createdIds.set(taskSpec.title, task.id);
        links.push(`• ${task.url ? `<${task.url}|${task.name}>` : task.name}`);
      }

      // Second pass: dependencies (needs all task IDs). Failures don't undo
      // the scaffold — they're reported for manual linking.
      /** @type {string[]} */
      const depNotes = [];
      for (const taskSpec of p.tasks) {
        for (const blockerTitle of taskSpec.blockedBy || []) {
          const taskId = createdIds.get(taskSpec.title);
          const blockerId = createdIds.get(blockerTitle);
          if (!taskId || !blockerId) {
            depNotes.push(`:warning: Could not link "${taskSpec.title}" ← "${blockerTitle}" (missing task ID).`);
            continue;
          }
          try {
            await clickup.addTaskDependency(taskId, blockerId);
          } catch (e) {
            depNotes.push(
              `:warning: Dependency "${taskSpec.title}" ← "${blockerTitle}" failed: ${/** @type {Error} */ (e).message}`,
            );
          }
        }
      }
      const depCount = p.tasks.reduce(
        (/** @type {number} */ n, /** @type {any} */ t) => n + (t.blockedBy?.length || 0),
        0,
      );
      const depSummary = depCount > 0 ? `\n${depCount - depNotes.length}/${depCount} dependencies linked.` : '';
      return {
        summary: `${links.length} milestone task(s) added to *${p.clientKey}*'s engagement list:\n${links.join('\n')}${depSummary}${depNotes.length ? `\n${depNotes.join('\n')}` : ''}`,
      };
    }

    case 'client_update':
      // No external write: approval marks the draft ready. A human copies it
      // into the client channel — the bot never posts there (hard rule).
      return {
        summary: 'Draft approved — ready for a human to copy and send. The bot never posts to client channels.',
      };

    case 'automation_idea': {
      const list = conventions.internal_lists?.automation_ideas;
      if (!list) throw new Error('internal_lists.automation_ideas is not configured in conventions.json.');
      const task = await clickup.createTask(list.list_id, {
        name: p.title,
        description: [p.description, `Submitted by <@${proposal.requesterId}> via Slack.`].filter(Boolean).join('\n\n'),
        // This list has its own status pipeline (e.g. backlog → … → complete),
        // unrelated to conventions.clickup.statuses used by client lists.
        status: list.default_status,
      });
      return { summary: `Automation idea logged: ${task.url ? `<${task.url}|${task.name}>` : task.name}` };
    }

    case 'client_registration': {
      // Writes to conventions.json (not ClickUp) and hot-reloads the config.
      addClientToConventions(p.clientKey, p.entry);
      const noteLines = p.notes?.length ? `\n${p.notes.map((/** @type {string} */ n) => `• ${n}`).join('\n')}` : '';
      return {
        summary: `Client *${p.entry.display_name}* registered as \`${p.clientKey}\` — config reloaded, no restart needed.${noteLines}`,
      };
    }

    default:
      throw new Error(`Unknown proposal type "${proposal.type}" — refusing to execute.`);
  }
}

/**
 * Who may approve what. Scaffolds and client updates are lead-only
 * (client-facing); tasks and QA writes may be approved by the requester or
 * any lead. Enforced here in code, never via the system prompt.
 * @param {import('./store.js').Proposal} proposal
 * @param {string} userId
 * @param {import('../config/index.js').Conventions} conventions
 * @returns {boolean}
 */
export function canApprove(proposal, userId, conventions) {
  const role = conventions.users[userId]?.role;
  if (proposal.type === 'scaffold' || proposal.type === 'client_update' || proposal.type === 'client_registration') {
    return role === 'lead';
  }
  return role === 'lead' || (userId === proposal.requesterId && role !== undefined);
}
