import {
  addClientToConventions,
  formatTaskName,
  getClickUpUserId,
  isKnownPriority,
  knownStatuses,
  resolvePriority,
  resolveStatus,
} from '../config/index.js';
import { canBotPostInChannel, resolveClientTargets } from '../config/resolver.js';
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
 * The client's ClickUp targets at write time. Config values win; any field left
 * blank or placeholder is resolved from the live ClickUp hierarchy, so a client
 * whose QA list was created after registration still works without a config
 * edit. Shaped like ClientConfig so call sites read unchanged.
 * @param {import('../config/index.js').Conventions} conventions
 * @param {string | undefined} clientKey
 * @param {{ getHierarchy: () => Promise<any> } | null} [clickup]
 * @returns {Promise<{ display_name: string, list_id: string, qa_list_id: string, folder_id: string }>}
 */
async function requireClient(conventions, clientKey, clickup = null) {
  const entry = clientKey ? conventions.clients[clientKey] : undefined;
  if (!entry) throw new Error(`Unknown client "${clientKey}" — check config/conventions.json.`);
  const targets = await resolveClientTargets({
    clientKey: /** @type {string} */ (clientKey),
    conventions,
    clickup,
  });
  return {
    display_name: entry.display_name,
    list_id: targets?.listId || '',
    qa_list_id: targets?.qaListId || '',
    folder_id: targets?.folderId || '',
  };
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
 * The images, files, and links the client shared with the request, rendered as
 * a Markdown section on the task description so whoever picks the task up has
 * the references without going back to Slack.
 * @param {string[] | undefined} refs
 * @returns {string}
 */
export function referenceSection(refs) {
  const items = (Array.isArray(refs) ? refs : []).map((r) => String(r).trim()).filter(Boolean);
  if (items.length === 0) return '';
  return `References shared by the client:\n${items.map((r) => `- ${r}`).join('\n')}`;
}

/**
 * A human-readable reporter name. Config first (no API call for teammates), then
 * a live Slack lookup so people who aren't in config are still named properly,
 * then the raw ID as a last resort.
 * @param {string} slackUserId
 * @param {import('../config/index.js').Conventions} conventions
 * @param {import('@slack/web-api').WebClient} [slack]
 * @returns {Promise<string>}
 */
async function resolveReporterName(slackUserId, conventions, slack) {
  const fromConfig = conventions.users[slackUserId]?.name;
  if (fromConfig) return fromConfig;
  if (slack) {
    try {
      const info = await slack.users.info({ user: slackUserId });
      const user = /** @type {any} */ (info).user;
      const name = user?.profile?.real_name || user?.real_name || user?.profile?.display_name || user?.name;
      if (name) return name;
    } catch {
      // Fall through — attribution is nice to have, not worth failing the write.
    }
  }
  return slackUserId;
}

/**
 * Upload each screenshot to the ClickUp task. Bytes are pulled from Slack with
 * our own bot token and posted as base64, so the Slack token is never handed to
 * ClickUp. A failed upload never fails the task — the report is worth more than
 * the image, so failures are reported in the summary instead.
 * @param {string | undefined} taskId
 * @param {string[] | undefined} fileIds
 * @param {import('@slack/web-api').WebClient} [slack]
 * @param {typeof clickupDefault} [clickup]
 * @returns {Promise<{ note: string }>}
 */
async function attachScreenshots(taskId, fileIds, slack, clickup) {
  const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
  if (ids.length === 0 || !taskId || !slack || !clickup?.attachTaskFile) return { note: '' };

  let ok = 0;
  const failed = [];
  for (const fileId of ids) {
    try {
      const info = await slack.files.info({ file: fileId });
      const file = /** @type {any} */ (info).file;
      const url = file?.url_private_download || file?.url_private;
      if (!url) throw new Error('no download URL');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${/** @type {any} */ (slack).token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Slack returned ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.subarray(0, 15).toString('latin1').trimStart().startsWith('<')) {
        throw new Error('Slack returned a login page, not the file (missing files:read?)');
      }
      await clickup.attachTaskFile(taskId, { fileName: file.name || `${fileId}.png`, data });
      ok += 1;
    } catch {
      failed.push(fileId);
    }
  }

  const parts = [];
  if (ok > 0) parts.push(`${ok} screenshot${ok === 1 ? '' : 's'} attached`);
  if (failed.length > 0) parts.push(`${failed.length} could not be attached`);
  return { note: parts.length > 0 ? ` — ${parts.join(', ')}.` : '' };
}

/**
 * Execute an approved proposal.
 * @param {import('./store.js').Proposal} proposal
 * @param {import('../config/index.js').Conventions} conventions
 * @param {typeof clickupDefault} [clickup] - Injectable for tests.
 * @param {import('@slack/web-api').WebClient} [slack] - Bot Web API client, required for canvas writes.
 * @returns {Promise<{ summary: string }>}
 */
export async function executeProposal(proposal, conventions, clickup = clickupDefault, slack = undefined) {
  const p = proposal.payload;

  switch (proposal.type) {
    case 'task': {
      const client = await requireClient(conventions, p.clientKey, clickup);
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
        description: [
          p.description,
          p.sourceQuote ? `Source (Slack):\n${p.sourceQuote}` : '',
          referenceSection(p.referenceUrls),
        ]
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
      const client = await requireClient(conventions, p.destClientKey, clickup);
      const toQa = Boolean(p.toQa);
      const listId = toQa ? client.qa_list_id : client.list_id;
      if (!listId) {
        throw new Error(
          toQa
            ? `${p.destClientKey} has no QA list — add one with "QA" in the name to their ClickUp folder.`
            : `${p.destClientKey} has no engagement list — check their ClickUp folder, or set list_id in config/conventions.json.`,
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
      const client = await requireClient(conventions, p.clientKey, clickup);
      const links = [];
      if (!client.qa_list_id) {
        throw new Error(
          `${p.clientKey} has no QA list — duplicate "QA Board Demo" into the client's ClickUp folder (any list ` +
            'with "QA" in the name is picked up automatically within 10 minutes), then re-propose.',
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
      const client = await requireClient(conventions, p.clientKey, clickup);
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

    case 'pm_agent_issue': {
      const list = conventions.internal_lists?.pm_agent_issues;
      if (!list) throw new Error('internal_lists.pm_agent_issues is not configured in conventions.json.');
      const kind = list.kinds?.[p.kind];
      if (!kind)
        throw new Error(`No tag mapping for "${p.kind}" — add internal_lists.pm_agent_issues.kinds.${p.kind}.`);

      // Attribute by human name, not a Slack mention: whoever picks this up in
      // ClickUp can't resolve a <@U…>, and reporters may not be in config.
      const reporter = await resolveReporterName(proposal.requesterId, conventions, slack);
      const assignee = list.assignee_slack_id ? getClickUpUserId(conventions, list.assignee_slack_id) : null;

      const fields = {
        name: p.title,
        description: [p.description, `Reported by ${reporter} via Slack DM.`].filter(Boolean).join('\n\n'),
        status: list.default_status,
        tags: [kind.tag],
        ...(kind.task_type && { task_type: kind.task_type }),
        ...(assignee !== null && { assignees: [assignee] }),
      };

      let task;
      try {
        task = await clickup.createTask(list.list_id, fields);
      } catch (e) {
        // A task type that doesn't exist in the workspace shouldn't lose the
        // report — retry without it and say so, keeping the tag as the signal.
        const message = /** @type {any} */ (e).message || '';
        if (!kind.task_type || !/task[_ ]?type/i.test(message)) throw e;
        const { task_type, ...withoutType } = fields;
        task = await clickup.createTask(list.list_id, withoutType);
        const link = task.url ? `<${task.url}|${task.name}>` : task.name;
        return {
          summary:
            `${p.kind === 'bug' ? 'Bug' : 'Feature request'} logged: ${link} — tagged \`${kind.tag}\`, but the ` +
            `"${task_type}" task type does not exist in the workspace, so the default type was used.`,
        };
      }

      const attached = await attachScreenshots(task.id, p.screenshotFileIds, slack, clickup);
      const link = task.url ? `<${task.url}|${task.name}>` : task.name;
      return {
        summary:
          `${p.kind === 'bug' ? 'Bug' : 'Feature request'} logged: ${link} (\`${kind.tag}\`` +
          `${assignee !== null ? `, assigned to ${conventions.users[/** @type {string} */ (list.assignee_slack_id)]?.name}` : ''})` +
          `${attached.note}`,
      };
    }

    case 'client_registration': {
      // Writes to conventions.json (not ClickUp) and hot-reloads the config.
      addClientToConventions(p.clientKey, p.entry);
      const noteLines = p.notes?.length ? `\n${p.notes.map((/** @type {string} */ n) => `• ${n}`).join('\n')}` : '';
      return {
        summary: `Client *${p.entry.display_name}* registered as \`${p.clientKey}\` — config reloaded, no restart needed.${noteLines}`,
      };
    }

    case 'canvas_update': {
      if (!slack) throw new Error('Canvas updates require the Slack client (internal error).');
      const channelId = p.channelId;
      // Hard rule: the bot never touches client channels. Guarded at propose
      // time too, but re-checked here in code — by channel name, fail-closed,
      // so an unmapped client channel is refused rather than waved through.
      const canvasTarget = await canBotPostInChannel({ client: slack, conventions, channelId });
      if (!canvasTarget.allowed) {
        throw new Error(
          `Refused: the bot never creates or edits canvases in client channels (${canvasTarget.reason}).`,
        );
      }
      const mode = p.mode || 'replace';
      const documentContent = { type: /** @type {'markdown'} */ ('markdown'), markdown: p.markdown };

      // A channel has at most one canvas; find it via conversations.info before
      // deciding whether to create or edit.
      let canvasId = null;
      try {
        const info = /** @type {any} */ (await slack.conversations.info({ channel: channelId }));
        canvasId = info?.channel?.properties?.canvas?.file_id || info?.channel?.properties?.canvas?.document_id || null;
      } catch {
        // Fall through to create; if a canvas actually exists the create call
        // reports it and we surface a clear message.
      }

      if (canvasId) {
        const operation = mode === 'append' ? 'insert_at_end' : mode === 'prepend' ? 'insert_at_start' : 'replace';
        await slack.canvases.edit({ canvas_id: canvasId, changes: [{ operation, document_content: documentContent }] });
        return { summary: `Canvas updated (${mode}) in <#${channelId}>.` };
      }

      try {
        await slack.conversations.canvases.create({
          channel_id: channelId,
          document_content: documentContent,
          ...(p.title ? { title: p.title } : {}),
        });
      } catch (e) {
        if (/** @type {any} */ (e)?.data?.error === 'channel_canvas_already_exists') {
          throw new Error(
            'This channel already has a canvas but its ID could not be resolved — try again, or edit it manually once.',
          );
        }
        throw e;
      }
      return { summary: `Canvas created in <#${channelId}>.` };
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
  // Bot bug/feature reports are about the bot itself, not client work, and the
  // whole team files them — including people not (yet) in the config. Whoever
  // reported it may approve their own; a lead may approve anyone's.
  if (proposal.type === 'pm_agent_issue') {
    return role === 'lead' || userId === proposal.requesterId;
  }
  return role === 'lead' || (userId === proposal.requesterId && role !== undefined);
}
