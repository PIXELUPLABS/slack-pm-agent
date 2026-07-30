/**
 * Block Kit approval cards. Every proposed write renders through here so the
 * approver sees exactly what will happen before deterministic code executes it.
 */

/** Proposal type → human heading. */
const HEADINGS = {
  task: ':memo: New ClickUp task',
  task_update: ':pencil2: ClickUp task update',
  task_move: ':truck: Move task',
  qa_tasks: ':mag: QA tasks',
  scaffold: ':building_construction: Project scaffold',
  client_update: ':newspaper: Client update draft',
  client_registration: ':card_index: Register client',
  automation_idea: ':bulb: Automation idea',
  pm_agent_issue: ':robot_face: PM Agent bug / idea',
  canvas_update: ':scroll: Channel canvas',
};

/**
 * @param {import('./store.js').Proposal} proposal
 * @returns {string}
 */
function summarizePayload(proposal) {
  const p = proposal.payload;
  switch (proposal.type) {
    case 'task': {
      const lines = [`*Title:* ${p.title}`, `*Client:* ${p.clientKey}`, `*Priority:* ${p.priority || 'default'}`];
      if (p.stageName) lines.push(`*Stage:* ${p.stageName}`);
      if (p.dueDate) lines.push(`*Due:* ${p.dueDate}`);
      if (p.assigneeNames?.length) lines.push(`*Assignee:* ${p.assigneeNames.join(', ')}`);
      if (p.parentTaskId) lines.push(`*Subtask of:* \`${p.parentTaskId}\``);
      if (p.tags?.length) lines.push(`*Tags:* ${p.tags.join(', ')}`);
      if (p.timeEstimateMinutes) lines.push(`*Estimate:* ${p.timeEstimateMinutes} min`);
      if (p.description) lines.push(`*Details:* ${p.description}`);
      if (p.sourceQuote) lines.push(`*Source message:*\n> ${String(p.sourceQuote).split('\n').join('\n> ')}`);
      if (p.referenceUrls?.length) {
        // Cards stay scannable; the full list always lands on the task itself.
        const shown = p.referenceUrls.slice(0, 5).map((/** @type {string} */ r) => `• ${r}`);
        const rest = p.referenceUrls.length - shown.length;
        lines.push(`*Client references:*\n${shown.join('\n')}${rest > 0 ? `\n• …and ${rest} more` : ''}`);
      }
      return lines.join('\n');
    }
    case 'task_update': {
      // Batch payload ({ updates: [...] }); single-task legacy shape normalizes to a one-entry batch.
      const updates = p.updates || [{ taskId: p.taskId, fields: p.fields }];
      const perTask = updates.map((/** @type {any} */ u) => {
        const changes = Object.entries(u.fields || {}).map(([key, value]) => `${key} → ${value}`);
        if (u.unassign) changes.push('assignee → (cleared)');
        else if (u.assigneeNames?.length) changes.push(`assignee → ${u.assigneeNames.join(', ')}`);
        return `• ${u.taskName ? `${u.taskName} (\`${u.taskId}\`)` : `\`${u.taskId}\``}: ${changes.join(', ')}`;
      });
      const heading = updates.length === 1 ? '*Changes:*' : `*Changes to ${updates.length} tasks:*`;
      return `${heading}\n${perTask.join('\n')}`;
    }
    case 'task_move': {
      const dest = `${p.destClientKey}${p.toQa ? ' — QA list' : ''}`;
      const label = p.taskName ? `${p.taskName} (\`${p.taskId}\`)` : `\`${p.taskId}\``;
      return `Move ${label} → *${dest}*`;
    }
    case 'qa_tasks': {
      const items = (p.tasks || [])
        .map(
          (/** @type {any} */ t) =>
            `• [${t.page || 'general'}${t.device ? ` / ${t.device}` : ''}] ${t.title} _(${t.severity || 'normal'})_`,
        )
        .join('\n');
      return `*Client:* ${p.clientKey} — ${p.tasks?.length || 0} task(s) into the QA list\n${items}`;
    }
    case 'scaffold': {
      const tasks = (p.tasks || [])
        .map((/** @type {any} */ t) => {
          const dates = t.startDate || t.dueDate ? `${t.startDate || '…'} → ${t.dueDate || '…'}` : null;
          const extras = [
            t.stageName,
            dates,
            t.priority,
            t.assigneeNames?.length ? t.assigneeNames.join(', ') : null,
            t.blockedBy?.length ? `blocked by: ${t.blockedBy.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return `• ${t.title}${extras ? ` _(${extras})_` : ''}`;
        })
        .join('\n');
      return `*Client:* ${p.clientKey} — ${p.tasks?.length || 0} milestone task(s) into the existing engagement list\n${tasks}`;
    }
    case 'client_update':
      return `*Client:* ${p.clientKey}\n\n${p.draft}`;
    case 'client_registration': {
      const e = p.entry || {};
      const lines = [
        `*Key:* \`${p.clientKey}\` (*${e.display_name}*)`,
        `*ClickUp folder:* \`${e.folder_id}\` · *list:* \`${e.list_id}\` · *QA list:* ${e.qa_list_id ? `\`${e.qa_list_id}\`` : '_none yet_'}`,
        `*Client channel:* ${e.channel_id ? `<#${e.channel_id}>` : '_not found_'} · *internal:* ${e.internal_channel_id ? `<#${e.internal_channel_id}>` : '_not found_'}`,
      ];
      if (p.notes?.length) lines.push(p.notes.map((/** @type {string} */ n) => `:warning: ${n}`).join('\n'));
      lines.push('_Approving writes this entry to conventions.json and reloads the config._');
      return lines.join('\n');
    }
    case 'pm_agent_issue': {
      const lines = [`*${p.kind === 'bug' ? 'Bug' : 'Feature request'}:* ${p.title}`];
      if (p.description) lines.push(`*Details:* ${p.description}`);
      const shots = p.screenshotFileIds?.length || 0;
      if (shots > 0) lines.push(`*Screenshots:* ${shots} will be attached to the task`);
      lines.push(`_Goes into PM Agent Bugs / Ideas, tagged \`${p.kind}\` and assigned for triage._`);
      return lines.join('\n');
    }

    case 'automation_idea': {
      const lines = [`*Idea:* ${p.title}`];
      if (p.description) lines.push(`*Details:* ${p.description}`);
      lines.push('_Goes into the Automation Ideas list (Operations space)._');
      return lines.join('\n');
    }
    case 'canvas_update': {
      const action =
        { replace: 'Replace the canvas content', append: 'Append to the canvas', prepend: 'Prepend to the canvas' }[
          /** @type {string} */ (p.mode || 'replace')
        ] || 'Update the canvas';
      const md = String(p.markdown || '');
      const previewLines = md.split('\n').slice(0, 8);
      const preview = previewLines.join('\n') + (md.split('\n').length > previewLines.length ? '\n…' : '');
      const lines = [`*Channel:* <#${p.channelId}>`, `*Action:* ${action}`];
      if (p.title) lines.push(`*Title:* ${p.title}`);
      lines.push(`*Content:*\n${preview}`);
      return lines.join('\n');
    }
    default:
      return '```' + JSON.stringify(p, null, 2) + '```';
  }
}

/**
 * Build the approval card for a pending proposal.
 * @param {import('./store.js').Proposal} proposal
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildApprovalCard(proposal) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${HEADINGS[proposal.type] || ':clipboard: Proposal'} — *awaiting approval*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summarizePayload(proposal) },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: 'proposal_approve',
          value: proposal.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: true },
          style: 'danger',
          action_id: 'proposal_reject',
          value: proposal.id,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Requested by <@${proposal.requesterId}> · nothing is written until approved`,
        },
      ],
    },
  ];
}

/**
 * Build the replacement blocks after a proposal is resolved.
 * @param {import('./store.js').Proposal} proposal
 * @param {{ outcome: 'executed' | 'rejected' | 'failed', actorId: string, detail?: string }} result
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildResolvedCard(proposal, result) {
  const icon = { executed: ':white_check_mark:', rejected: ':no_entry_sign:', failed: ':warning:' }[result.outcome];
  const verb = { executed: 'Approved & executed', rejected: 'Rejected', failed: 'Approved, but execution failed' }[
    result.outcome
  ];
  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${HEADINGS[proposal.type] || ':clipboard: Proposal'} — ${icon} *${verb}*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summarizePayload(proposal) },
    },
  ];
  if (result.detail) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: result.detail } });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${verb} by <@${result.actorId}>` }],
  });
  return blocks;
}
