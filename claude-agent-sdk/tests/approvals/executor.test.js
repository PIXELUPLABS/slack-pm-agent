import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { canApprove, executeProposal } from '../../approvals/executor.js';
import { validateConventions } from '../../config/index.js';

function conventions() {
  return validateConventions({
    agency: { name: 'Pixelup Labs', voice: 'Direct.' },
    clickup: {
      task_name_format: '[{client}] {title}',
      priorities: { urgent: 1, high: 2, normal: 3, low: 4 },
      default_priority: 'normal',
      statuses: ['to do', 'done'],
      default_status: 'to do',
    },
    clients: {
      acme: { display_name: 'Acme', channel_id: 'C0ACME', list_id: 'L1', qa_list_id: 'L2', folder_id: 'F1' },
    },
    users: {
      U0LEAD: { name: 'Lead', clickup_user_id: 11, role: 'lead' },
      U0MEMBER: { name: 'Member', clickup_user_id: 22, role: 'member' },
    },
    channels: { drafts_channel_id: 'C0DRAFTS' },
    client_updates: { enabled: false, days: ['tuesday'], hour: 9, minute: 0, timezone: 'UTC' },
  });
}

/** @param {Partial<import('../../approvals/store.js').Proposal>} overrides */
function proposal(overrides) {
  return /** @type {import('../../approvals/store.js').Proposal} */ ({
    id: 'p-1',
    requesterId: 'U0MEMBER',
    status: 'pending',
    createdAt: Date.now(),
    ...overrides,
  });
}

describe('executeProposal', () => {
  let fakeClickUp;

  beforeEach(() => {
    let taskCounter = 0;
    fakeClickUp = {
      createTask: mock.fn(async (_listId, fields) => {
        taskCounter += 1;
        return { id: `t${taskCounter}`, name: fields.name, url: `https://cu/t${taskCounter}` };
      }),
      updateTask: mock.fn(async (taskId, _fields) => ({ id: taskId, name: 'Task', url: `https://cu/${taskId}` })),
      createList: mock.fn(async (_folderId, name) => ({ id: 'newlist', name })),
      addTaskDependency: mock.fn(async () => {}),
    };
  });

  it('task: creates in the client list with mapped fields', async () => {
    const p = proposal({
      type: 'task',
      payload: {
        clientKey: 'acme',
        title: 'Fix header',
        description: 'Client asked',
        priority: 'high',
        dueDate: '2026-07-20',
        assigneeSlackId: 'U0MEMBER',
        sourceQuote: 'please fix the header',
      },
    });
    const result = await executeProposal(p, conventions(), fakeClickUp);
    assert.strictEqual(fakeClickUp.createTask.mock.callCount(), 1);
    const [listId, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
    assert.strictEqual(listId, 'L1');
    assert.strictEqual(fields.name, '[Acme] Fix header');
    assert.strictEqual(fields.priority, 2);
    assert.deepStrictEqual(fields.assignees, [22]);
    assert.ok(fields.description.includes('please fix the header'));
    assert.strictEqual(fields.due_date, Date.parse('2026-07-20'));
    assert.ok(result.summary.includes('https://cu/t1'));
  });

  it('task: rejects unknown clients', async () => {
    const p = proposal({ type: 'task', payload: { clientKey: 'ghost', title: 'x' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown client "ghost"/);
  });

  it('task: sets the Project Stage custom field when a stage was proposed', async () => {
    const p = proposal({
      type: 'task',
      payload: {
        clientKey: 'acme',
        title: 'Blog page design',
        stageName: 'visual design',
        stageOptionId: 'opt-design',
      },
    });
    const conv = conventions();
    conv.clickup.project_stage_field = { id: 'field-1', options: { 'visual design': 'opt-design' } };
    await executeProposal(p, conv, fakeClickUp);
    // Stage rides as the Project Stage custom field (drives board grouping).
    assert.deepStrictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].custom_fields, [
      { id: 'field-1', value: 'opt-design' },
    ]);
  });

  it('task: omits custom_fields when no stage was proposed', async () => {
    const p = proposal({ type: 'task', payload: { clientKey: 'acme', title: 'Blog page design' } });
    const conv = conventions();
    conv.clickup.project_stage_field = { id: 'field-1', options: { 'visual design': 'opt-design' } };
    await executeProposal(p, conv, fakeClickUp);
    assert.strictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].custom_fields, undefined);
  });

  it('task_update: passes only whitelisted fields', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', fields: { status: 'done', priority: 'urgent', sneaky_field: 'x' } }] },
    });
    await executeProposal(p, conventions(), fakeClickUp);
    const [taskId, fields] = fakeClickUp.updateTask.mock.calls[0].arguments;
    assert.strictEqual(taskId, 't9');
    assert.deepStrictEqual(fields, { status: 'done', priority: 1 });
  });

  it('task_update: executes a batch of tasks from one proposal', async () => {
    const p = proposal({
      type: 'task_update',
      payload: {
        updates: [
          { taskId: 't1', taskName: 'Blog page design', fields: { stage: 'visual design' } },
          { taskId: 't2', taskName: 'Blog page development', fields: { stage: 'dev' } },
        ],
      },
    });
    const conv = conventions();
    conv.clickup.project_stage_field = { id: 'field-1', options: { 'visual design': 'opt-design', dev: 'opt-dev' } };
    const result = await executeProposal(p, conv, fakeClickUp);
    assert.strictEqual(fakeClickUp.updateTask.mock.callCount(), 2);
    assert.deepStrictEqual(fakeClickUp.updateTask.mock.calls[0].arguments[1], {
      custom_fields: [{ id: 'field-1', value: 'opt-design' }],
    });
    assert.deepStrictEqual(fakeClickUp.updateTask.mock.calls[1].arguments[1], {
      custom_fields: [{ id: 'field-1', value: 'opt-dev' }],
    });
    assert.ok(result.summary.includes('2 task(s) updated'));
    assert.ok(result.summary.includes('Blog page design'));
  });

  it('task_update: legacy single-task payload still executes', async () => {
    const p = proposal({ type: 'task_update', payload: { taskId: 't9', fields: { status: 'done' } } });
    await executeProposal(p, conventions(), fakeClickUp);
    const [taskId, fields] = fakeClickUp.updateTask.mock.calls[0].arguments;
    assert.strictEqual(taskId, 't9');
    assert.deepStrictEqual(fields, { status: 'done' });
  });

  it('task_update: rejects when nothing updatable remains', async () => {
    const p = proposal({ type: 'task_update', payload: { updates: [{ taskId: 't9', fields: { bogus: '1' } }] } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /No updatable fields/);
  });

  it('task_update: translates stage into the Project Stage custom field', async () => {
    const p = proposal({ type: 'task_update', payload: { updates: [{ taskId: 't9', fields: { stage: 'dev' } }] } });
    const conv = conventions();
    conv.clickup.project_stage_field = { id: 'field-1', options: { dev: 'opt-dev' } };
    await executeProposal(p, conv, fakeClickUp);
    const [taskId, fields] = fakeClickUp.updateTask.mock.calls[0].arguments;
    assert.strictEqual(taskId, 't9');
    assert.deepStrictEqual(fields, { custom_fields: [{ id: 'field-1', value: 'opt-dev' }] });
  });

  it('task_update: rejects a stage that does not resolve', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', fields: { stage: 'shipping' } }] },
    });
    const conv = conventions();
    conv.clickup.project_stage_field = { id: 'field-1', options: { dev: 'opt-dev' } };
    await assert.rejects(() => executeProposal(p, conv, fakeClickUp), /Unknown stage "shipping"/);
  });

  it('qa_tasks: creates each task in the QA list with severity mapped to priority', async () => {
    const p = proposal({
      type: 'qa_tasks',
      payload: {
        clientKey: 'acme',
        tasks: [{ title: 'Broken button', page: 'Home', device: 'mobile', severity: 'urgent' }, { title: 'Typo' }],
      },
    });
    const result = await executeProposal(p, conventions(), fakeClickUp);
    assert.strictEqual(fakeClickUp.createTask.mock.callCount(), 2);
    const [listId, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
    assert.strictEqual(listId, 'L2');
    assert.strictEqual(fields.name, '[Home / mobile] Broken button');
    assert.strictEqual(fields.priority, 1);
    assert.ok(result.summary.includes('2 QA task(s)'));
  });

  it('scaffold: adds milestone tasks to the existing engagement list, never creates lists', async () => {
    const p = proposal({
      type: 'scaffold',
      requesterId: 'U0LEAD',
      payload: {
        clientKey: 'acme',
        tasks: [
          {
            title: 'Moodboard',
            startDate: '2026-07-13',
            dueDate: '2026-07-20',
            assigneeSlackIds: ['U0MEMBER', 'U0LEAD', 'U0UNKNOWN'],
            stageOptionId: 'opt-design',
          },
          { title: 'Wireframes', priority: 'high', blockedBy: ['Moodboard'] },
        ],
      },
    });
    const conv = conventions();
    conv.clickup.project_stage_field = { id: 'field-1', options: { 'visual design': 'opt-design' } };
    const result = await executeProposal(p, conv, fakeClickUp);
    // Folders are duplicated from the demo template — the list already exists.
    assert.strictEqual(fakeClickUp.createList.mock.callCount(), 0);
    assert.strictEqual(fakeClickUp.createTask.mock.callCount(), 2);
    assert.strictEqual(fakeClickUp.createTask.mock.calls[0].arguments[0], 'L1');
    // Slack IDs resolve to ClickUp IDs; unknown users are dropped, not guessed.
    assert.deepStrictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].assignees, [22, 11]);
    assert.strictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].start_date, Date.parse('2026-07-13'));
    assert.strictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].due_date, Date.parse('2026-07-20'));
    // Stage rides as the Project Stage custom field (drives board grouping).
    assert.deepStrictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].custom_fields, [
      { id: 'field-1', value: 'opt-design' },
    ]);
    assert.strictEqual(fakeClickUp.createTask.mock.calls[1].arguments[1].assignees, undefined);
    assert.strictEqual(fakeClickUp.createTask.mock.calls[1].arguments[1].custom_fields, undefined);
    // Wireframes (t2) waits on Moodboard (t1).
    assert.strictEqual(fakeClickUp.addTaskDependency.mock.callCount(), 1);
    assert.deepStrictEqual(fakeClickUp.addTaskDependency.mock.calls[0].arguments, ['t2', 't1']);
    assert.ok(result.summary.includes('2 milestone task(s)'));
    assert.ok(result.summary.includes('1/1 dependencies linked'));
  });

  it('scaffold: rejects an empty task list', async () => {
    const p = proposal({ type: 'scaffold', requesterId: 'U0LEAD', payload: { clientKey: 'acme', tasks: [] } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /No tasks in this scaffold/);
  });

  it('client_update: writes nothing to ClickUp', async () => {
    const p = proposal({ type: 'client_update', payload: { clientKey: 'acme', draft: 'Weekly update…' } });
    const result = await executeProposal(p, conventions(), fakeClickUp);
    assert.strictEqual(fakeClickUp.createTask.mock.callCount(), 0);
    assert.strictEqual(fakeClickUp.updateTask.mock.callCount(), 0);
    assert.strictEqual(fakeClickUp.createList.mock.callCount(), 0);
    assert.ok(result.summary.includes('never posts to client channels'));
  });

  it('refuses unknown proposal types', async () => {
    const p = proposal({ type: /** @type {any} */ ('delete_everything'), payload: {} });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown proposal type/);
  });
});

describe('canApprove', () => {
  const conv = conventions();

  it('requester (member) can approve their own task proposal', () => {
    const p = proposal({ type: 'task', payload: {} });
    assert.strictEqual(canApprove(p, 'U0MEMBER', conv), true);
  });

  it('leads can approve any proposal', () => {
    assert.strictEqual(canApprove(proposal({ type: 'task', payload: {} }), 'U0LEAD', conv), true);
    assert.strictEqual(canApprove(proposal({ type: 'scaffold', payload: {} }), 'U0LEAD', conv), true);
    assert.strictEqual(canApprove(proposal({ type: 'client_update', payload: {} }), 'U0LEAD', conv), true);
  });

  it('members cannot approve scaffolds or client updates, even their own', () => {
    assert.strictEqual(canApprove(proposal({ type: 'scaffold', payload: {} }), 'U0MEMBER', conv), false);
    assert.strictEqual(canApprove(proposal({ type: 'client_update', payload: {} }), 'U0MEMBER', conv), false);
  });

  it('users outside the config can approve nothing', () => {
    assert.strictEqual(
      canApprove(proposal({ type: 'task', payload: {}, requesterId: 'U0STRANGER' }), 'U0STRANGER', conv),
      false,
    );
  });
});
