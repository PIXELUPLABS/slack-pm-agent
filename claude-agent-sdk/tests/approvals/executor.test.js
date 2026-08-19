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
    internal_lists: {
      automation_ideas: { display_name: 'Automation Ideas', list_id: 'AUTOLIST', default_status: 'backlog' },
      pm_agent_issues: {
        display_name: 'PM Agent Bugs / Ideas',
        list_id: 'PMLIST',
        default_status: 'backlog',
        assignee_slack_id: 'U0LEAD',
        kinds: { bug: { tag: 'bug', task_type: 'Bug' }, feature: { tag: 'feature', task_type: 'Feature' } },
      },
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

/**
 * Minimal Slack Web API fake for canvas tests. `name` matters: the client-channel
 * guard classifies by channel name and fails closed, so a nameless channel is
 * refused (see the dedicated test below).
 * @param {{ existingCanvasId?: string | null, name?: string }} [opts]
 */
function fakeSlack({ existingCanvasId = null, name = 'pixelup-team' } = {}) {
  return {
    conversations: {
      info: mock.fn(async () => ({
        ok: true,
        channel: {
          name,
          properties: existingCanvasId ? { canvas: { file_id: existingCanvasId } } : {},
        },
      })),
      canvases: {
        create: mock.fn(async () => ({ ok: true, canvas_id: 'NEWCANVAS' })),
      },
    },
    canvases: {
      edit: mock.fn(async () => ({ ok: true })),
    },
    chat: {
      postMessage: mock.fn(async (/** @type {any} */ args) => ({ ok: true, channel: args.channel, ts: '1.2' })),
      getPermalink: mock.fn(async () => ({ ok: true, permalink: 'https://slack.test/p1' })),
    },
  };
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
      moveTask: mock.fn(async () => {}),
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

  it('task: attaches the client references to the description', async () => {
    const p = proposal({
      type: 'task',
      payload: {
        clientKey: 'acme',
        title: 'New landing page hero',
        sourceQuote: 'here is the reference',
        referenceUrls: ['hero-ref.png: https://files.slack.com/hero-ref.png', 'https://dribbble.com/shots/123'],
      },
    });
    await executeProposal(p, conventions(), fakeClickUp);
    const [, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
    assert.ok(fields.description.includes('References shared by the client:'));
    assert.ok(fields.description.includes('- hero-ref.png: https://files.slack.com/hero-ref.png'));
    assert.ok(fields.description.includes('- https://dribbble.com/shots/123'));
  });

  it('task: omits the references section when the client shared nothing', async () => {
    const p = proposal({ type: 'task', payload: { clientKey: 'acme', title: 'Logo concepts' } });
    await executeProposal(p, conventions(), fakeClickUp);
    const [, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
    assert.ok(!fields.description.includes('References shared by the client'));
  });

  it('task: rejects unknown clients', async () => {
    const p = proposal({ type: 'task', payload: { clientKey: 'ghost', title: 'x' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown client "ghost"/);
  });

  it('task: creates with multiple assignees, a parent, tags, and an estimate', async () => {
    const p = proposal({
      type: 'task',
      payload: {
        clientKey: 'acme',
        title: 'Sub work',
        assigneeSlackIds: ['U0MEMBER', 'U0LEAD'],
        parentTaskId: 'parent99',
        tags: ['design', 'urgent'],
        timeEstimateMinutes: 150,
      },
    });
    await executeProposal(p, conventions(), fakeClickUp);
    const [listId, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
    assert.strictEqual(listId, 'L1');
    assert.deepStrictEqual(fields.assignees, [22, 11]);
    assert.strictEqual(fields.parent, 'parent99');
    assert.deepStrictEqual(fields.tags, ['design', 'urgent']);
    assert.strictEqual(fields.time_estimate, 150);
  });

  describe('pm_agent_issue', () => {
    /** Slack fake with the file + user lookups the screenshot path needs. */
    function slackWithFiles({ fileName = 'shot.png', bytes = 'PNGDATA', userName = 'Outside Person' } = {}) {
      return {
        conversations: { info: mock.fn(async () => ({ ok: true, channel: { name: 'pixelup-team' } })) },
        files: {
          info: mock.fn(async () => ({
            ok: true,
            file: { name: fileName, url_private_download: 'https://files.slack.com/x' },
          })),
        },
        users: { info: mock.fn(async () => ({ ok: true, user: { profile: { real_name: userName } } })) },
        token: 'xoxb-test',
        _bytes: bytes,
      };
    }

    it('bug: tags, types, assigns to the configured owner, and names the reporter', async () => {
      const p = proposal({
        type: 'pm_agent_issue',
        requesterId: 'U0MEMBER',
        payload: { kind: 'bug', title: 'Recap did not post', description: 'Ran it twice, nothing appeared.' },
      });
      const result = await executeProposal(p, conventions(), fakeClickUp, slackWithFiles());

      const [listId, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
      assert.strictEqual(listId, 'PMLIST');
      assert.strictEqual(fields.name, 'Recap did not post');
      assert.strictEqual(fields.status, 'backlog');
      assert.deepStrictEqual(fields.tags, ['bug']);
      assert.strictEqual(fields.task_type, 'Bug');
      // Everything in this list is assigned to the configured owner (the lead).
      assert.deepStrictEqual(fields.assignees, [11]);
      // Reporter by NAME, and no raw Slack mention.
      assert.ok(fields.description.includes('Reported by Member via Slack DM.'));
      assert.ok(!fields.description.includes('<@'));
      assert.ok(result.summary.includes('Bug logged'));
    });

    it('feature: uses the feature tag and type', async () => {
      const p = proposal({ type: 'pm_agent_issue', payload: { kind: 'feature', title: 'Support Loom links' } });
      const result = await executeProposal(p, conventions(), fakeClickUp, slackWithFiles());
      const [, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
      assert.deepStrictEqual(fields.tags, ['feature']);
      assert.strictEqual(fields.task_type, 'Feature');
      assert.ok(result.summary.includes('Feature request logged'));
    });

    it('names a reporter who is not in the config, via Slack', async () => {
      const slack = slackWithFiles({ userName: 'New Designer' });
      const p = proposal({ type: 'pm_agent_issue', requesterId: 'U0NEWBIE', payload: { kind: 'bug', title: 'x' } });
      await executeProposal(p, conventions(), fakeClickUp, slack);
      const [, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
      assert.ok(fields.description.includes('Reported by New Designer via Slack DM.'));
      assert.strictEqual(slack.users.info.mock.callCount(), 1);
    });

    it('uploads screenshots as ClickUp attachments, never the Slack token', async () => {
      const slack = slackWithFiles();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer,
      }));
      const attach = mock.fn(async () => {});
      try {
        const p = proposal({
          type: 'pm_agent_issue',
          payload: { kind: 'bug', title: 'Card looks wrong', screenshotFileIds: ['F111', 'F222'] },
        });
        const result = await executeProposal(p, conventions(), { ...fakeClickUp, attachTaskFile: attach }, slack);

        assert.strictEqual(attach.mock.callCount(), 2);
        const [taskId, file] = attach.mock.calls[0].arguments;
        assert.strictEqual(taskId, 't1');
        assert.strictEqual(file.fileName, 'shot.png');
        assert.ok(Buffer.isBuffer(file.data));
        // Slack auth stayed on our side: the token went to Slack, not ClickUp.
        const [, init] = globalThis.fetch.mock.calls[0].arguments;
        assert.strictEqual(init.headers.Authorization, 'Bearer xoxb-test');
        assert.ok(!JSON.stringify(attach.mock.calls[0].arguments).includes('xoxb-test'));
        assert.ok(result.summary.includes('2 screenshots attached'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('still logs the issue when a screenshot upload fails', async () => {
      const slack = slackWithFiles();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
      try {
        const p = proposal({ type: 'pm_agent_issue', payload: { kind: 'bug', title: 'x', screenshotFileIds: ['F1'] } });
        const result = await executeProposal(p, conventions(), { ...fakeClickUp, attachTaskFile: mock.fn() }, slack);
        assert.strictEqual(fakeClickUp.createTask.mock.callCount(), 1);
        assert.ok(result.summary.includes('1 could not be attached'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('retries without the task type when the workspace has no such type', async () => {
      // "Feature" may not exist in the workspace; the report must still land.
      let call = 0;
      const clickup = {
        ...fakeClickUp,
        createTask: mock.fn(async (_listId, fields) => {
          call += 1;
          if (call === 1) throw new Error('Invalid task_type: Feature not found in workspace');
          return { id: 't9', name: fields.name, url: 'https://cu/t9' };
        }),
      };
      const p = proposal({ type: 'pm_agent_issue', payload: { kind: 'feature', title: 'Weekly digest' } });
      const result = await executeProposal(p, conventions(), clickup, slackWithFiles());

      assert.strictEqual(clickup.createTask.mock.callCount(), 2);
      const [, retried] = clickup.createTask.mock.calls[1].arguments;
      assert.strictEqual(retried.task_type, undefined);
      assert.deepStrictEqual(retried.tags, ['feature']);
      assert.ok(result.summary.includes('does not exist in the workspace'));
    });

    it('does not swallow unrelated create failures', async () => {
      const clickup = {
        ...fakeClickUp,
        createTask: mock.fn(async () => {
          throw new Error('rate limited');
        }),
      };
      const p = proposal({ type: 'pm_agent_issue', payload: { kind: 'bug', title: 'x' } });
      await assert.rejects(() => executeProposal(p, conventions(), clickup, slackWithFiles()), /rate limited/);
      assert.strictEqual(clickup.createTask.mock.callCount(), 1);
    });

    it('fails clearly when the list is not configured', async () => {
      const conv = conventions();
      delete conv.internal_lists.pm_agent_issues;
      const p = proposal({ type: 'pm_agent_issue', payload: { kind: 'bug', title: 'x' } });
      await assert.rejects(
        () => executeProposal(p, conv, fakeClickUp, slackWithFiles()),
        /pm_agent_issues is not configured/,
      );
    });
  });

  it('task_move: moves into the client engagement list', async () => {
    const p = proposal({ type: 'task_move', payload: { taskId: 't9', taskName: 'Header', destClientKey: 'acme' } });
    const result = await executeProposal(p, conventions(), fakeClickUp);
    assert.deepStrictEqual(fakeClickUp.moveTask.mock.calls[0].arguments, ['t9', 'L1']);
    assert.ok(result.summary.includes('engagement'));
  });

  it('task_move: moves into the client QA list when to_qa_list is set', async () => {
    const p = proposal({ type: 'task_move', payload: { taskId: 't9', destClientKey: 'acme', toQa: true } });
    const result = await executeProposal(p, conventions(), fakeClickUp);
    assert.deepStrictEqual(fakeClickUp.moveTask.mock.calls[0].arguments, ['t9', 'L2']);
    assert.ok(result.summary.includes('QA'));
  });

  it('task_move: rejects a QA move when the client has no QA list', async () => {
    const conv = conventions();
    conv.clients.acme.qa_list_id = undefined;
    const p = proposal({ type: 'task_move', payload: { taskId: 't9', destClientKey: 'acme', toQa: true } });
    await assert.rejects(() => executeProposal(p, conv, fakeClickUp), /no QA list/);
  });

  it('task_move: rejects an unknown destination client', async () => {
    const p = proposal({ type: 'task_move', payload: { taskId: 't9', destClientKey: 'ghost' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown client "ghost"/);
  });

  it('canvas_update: creates a canvas when the channel has none', async () => {
    const slack = fakeSlack({ existingCanvasId: null });
    const p = proposal({
      type: 'canvas_update',
      payload: { channelId: 'C0INT', markdown: '# Status', mode: 'replace', title: 'Status' },
    });
    const result = await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.conversations.canvases.create.mock.callCount(), 1);
    const arg = slack.conversations.canvases.create.mock.calls[0].arguments[0];
    assert.strictEqual(arg.channel_id, 'C0INT');
    assert.deepStrictEqual(arg.document_content, { type: 'markdown', markdown: '# Status' });
    assert.strictEqual(arg.title, 'Status');
    assert.strictEqual(slack.canvases.edit.mock.callCount(), 0);
    assert.ok(result.summary.includes('created'));
  });

  it('canvas_update: edits the existing canvas (append → insert_at_end)', async () => {
    const slack = fakeSlack({ existingCanvasId: 'F123' });
    const p = proposal({ type: 'canvas_update', payload: { channelId: 'C0INT', markdown: 'more', mode: 'append' } });
    const result = await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.canvases.edit.mock.callCount(), 1);
    const arg = slack.canvases.edit.mock.calls[0].arguments[0];
    assert.strictEqual(arg.canvas_id, 'F123');
    assert.deepStrictEqual(arg.changes, [
      { operation: 'insert_at_end', document_content: { type: 'markdown', markdown: 'more' } },
    ]);
    assert.strictEqual(slack.conversations.canvases.create.mock.callCount(), 0);
    assert.ok(result.summary.includes('append'));
  });

  it('canvas_update: replace mode maps to a replace operation', async () => {
    const slack = fakeSlack({ existingCanvasId: 'F123' });
    const p = proposal({ type: 'canvas_update', payload: { channelId: 'C0INT', markdown: 'x', mode: 'replace' } });
    await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.canvases.edit.mock.calls[0].arguments[0].changes[0].operation, 'replace');
  });

  it('canvas_update: refuses a client channel', async () => {
    const slack = fakeSlack();
    const p = proposal({ type: 'canvas_update', payload: { channelId: 'C0ACME', markdown: 'x' } });
    await assert.rejects(
      () => executeProposal(p, conventions(), fakeClickUp, slack),
      /never creates or edits canvases in client channels/,
    );
    assert.strictEqual(slack.conversations.canvases.create.mock.callCount(), 0);
  });

  it('canvas_update: fails clearly without a Slack client', async () => {
    const p = proposal({ type: 'canvas_update', payload: { channelId: 'C0INT', markdown: 'x' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp, undefined), /require the Slack client/);
  });

  it('channel_message: posts to the internal channel with mentions prepended', async () => {
    const slack = fakeSlack();
    const p = proposal({
      type: 'channel_message',
      payload: {
        channelId: 'C0INT',
        text: 'please drop a Varick update',
        mentionIds: ['U0FARHAN', 'U0KRISH'],
        mentionNames: ['Farhan', 'Krish Savani'],
      },
    });
    const result = await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 1);
    const arg = slack.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(arg.channel, 'C0INT');
    // Mentions are rendered here, from IDs — this is what actually notifies.
    assert.strictEqual(arg.text, '<@U0FARHAN> <@U0KRISH> please drop a Varick update');
    assert.strictEqual(arg.thread_ts, undefined);
    assert.match(result.summary, /Farhan, Krish Savani/);
    assert.match(result.summary, /Posted in <#C0INT> \(<https:\/\/slack\.test\/p1\|view>\)/);
  });

  it('channel_message: posts without a mention prefix when nobody is tagged', async () => {
    const slack = fakeSlack();
    const p = proposal({ type: 'channel_message', payload: { channelId: 'C0INT', text: 'standup moved to 10' } });
    await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.chat.postMessage.mock.calls[0].arguments[0].text, 'standup moved to 10');
  });

  it('channel_message: replies in a thread when threadTs is set', async () => {
    const slack = fakeSlack();
    const p = proposal({ type: 'channel_message', payload: { channelId: 'C0INT', text: 'bump', threadTs: '9.9' } });
    await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.chat.postMessage.mock.calls[0].arguments[0].thread_ts, '9.9');
  });

  it('channel_message: refuses a client channel', async () => {
    const slack = fakeSlack();
    const p = proposal({ type: 'channel_message', payload: { channelId: 'C0ACME', text: 'hello' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp, slack), /never posts in client channels/);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 0);
  });

  it('channel_message: refuses a channel it cannot identify (fail-closed)', async () => {
    // A channel Slack won't name at all — the guard must refuse, not assume.
    const slack = fakeSlack({ name: null });
    const p = proposal({ type: 'channel_message', payload: { channelId: 'C0MYSTERY', text: 'hello' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp, slack), /never posts in client channels/);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 0);
  });

  it('channel_message: still reports success when the permalink lookup fails', async () => {
    const slack = fakeSlack();
    slack.chat.getPermalink = mock.fn(async () => {
      throw new Error('permalink unavailable');
    });
    const p = proposal({ type: 'channel_message', payload: { channelId: 'C0INT', text: 'ok' } });
    const result = await executeProposal(p, conventions(), fakeClickUp, slack);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 1);
    assert.match(result.summary, /Posted in <#C0INT>/);
  });

  it('channel_message: fails clearly without a Slack client', async () => {
    const p = proposal({ type: 'channel_message', payload: { channelId: 'C0INT', text: 'x' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp, undefined), /require the Slack client/);
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

  it('task_update: reassigns by resolving Slack IDs to ClickUp user IDs', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', fields: { status: 'done' }, assigneeSlackIds: ['U0MEMBER'] }] },
    });
    await executeProposal(p, conventions(), fakeClickUp);
    const [taskId, fields] = fakeClickUp.updateTask.mock.calls[0].arguments;
    assert.strictEqual(taskId, 't9');
    assert.deepStrictEqual(fields, { status: 'done', assignees: [22] });
  });

  it('task_update: assignee-only update executes without other fields', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', assigneeSlackIds: ['U0MEMBER', 'U0LEAD'] }] },
    });
    await executeProposal(p, conventions(), fakeClickUp);
    const [taskId, fields] = fakeClickUp.updateTask.mock.calls[0].arguments;
    assert.strictEqual(taskId, 't9');
    assert.deepStrictEqual(fields, { assignees: [22, 11] });
  });

  it('task_update: rejects when no requested assignee is in the mapping', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', assigneeSlackIds: ['U0GHOST'] }] },
    });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /None of the requested assignees/);
  });

  it('task_update: unassign clears all assignees', async () => {
    const p = proposal({ type: 'task_update', payload: { updates: [{ taskId: 't9', unassign: true }] } });
    await executeProposal(p, conventions(), fakeClickUp);
    const [taskId, fields] = fakeClickUp.updateTask.mock.calls[0].arguments;
    assert.strictEqual(taskId, 't9');
    assert.deepStrictEqual(fields, { clear_assignees: true });
  });

  it('task_update: unassign takes precedence over assignee_slack_ids', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', unassign: true, assigneeSlackIds: ['U0MEMBER'] }] },
    });
    await executeProposal(p, conventions(), fakeClickUp);
    assert.deepStrictEqual(fakeClickUp.updateTask.mock.calls[0].arguments[1], { clear_assignees: true });
  });

  it('task_update: normalizes status casing to the config canonical', async () => {
    const p = proposal({ type: 'task_update', payload: { updates: [{ taskId: 't9', fields: { status: 'DONE' } }] } });
    await executeProposal(p, conventions(), fakeClickUp);
    assert.deepStrictEqual(fakeClickUp.updateTask.mock.calls[0].arguments[1], { status: 'done' });
  });

  it('task_update: rejects an unknown status before writing', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', fields: { status: 'shipping' } }] },
    });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown status "shipping"/);
  });

  it('task_update: rejects an unknown priority before writing', async () => {
    const p = proposal({
      type: 'task_update',
      payload: { updates: [{ taskId: 't9', fields: { priority: 'ultra' } }] },
    });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown priority "ultra"/);
  });

  it('task: rejects an unknown priority before writing', async () => {
    const p = proposal({ type: 'task', payload: { clientKey: 'acme', title: 'x', priority: 'ultra' } });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown priority "ultra"/);
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

  it('automation_idea: creates a task in the configured internal list', async () => {
    const p = proposal({
      type: 'automation_idea',
      payload: { title: 'Auto-draft standup summaries', description: 'Pull from Slack threads each morning.' },
    });
    const result = await executeProposal(p, conventions(), fakeClickUp);
    assert.strictEqual(fakeClickUp.createTask.mock.callCount(), 1);
    const [listId, fields] = fakeClickUp.createTask.mock.calls[0].arguments;
    assert.strictEqual(listId, 'AUTOLIST');
    assert.strictEqual(fields.name, 'Auto-draft standup summaries');
    assert.strictEqual(fields.status, 'backlog');
    assert.ok(fields.description.includes('Pull from Slack threads'));
    assert.ok(fields.description.includes('<@U0MEMBER>'));
    assert.ok(result.summary.includes('Automation idea logged'));
  });

  it('automation_idea: omits status rather than falling back to a client-list status', async () => {
    const p = proposal({ type: 'automation_idea', payload: { title: 'x' } });
    const conv = conventions();
    delete conv.internal_lists.automation_ideas.default_status;
    await executeProposal(p, conv, fakeClickUp);
    assert.strictEqual(fakeClickUp.createTask.mock.calls[0].arguments[1].status, undefined);
  });

  it('automation_idea: rejects when the list is not configured', async () => {
    const p = proposal({ type: 'automation_idea', payload: { title: 'x' } });
    const conv = conventions();
    delete conv.internal_lists;
    await assert.rejects(() => executeProposal(p, conv, fakeClickUp), /internal_lists\.automation_ideas/);
  });

  it('refuses unknown proposal types', async () => {
    const p = proposal({ type: /** @type {any} */ ('delete_everything'), payload: {} });
    await assert.rejects(() => executeProposal(p, conventions(), fakeClickUp), /Unknown proposal type/);
  });
});

describe('canApprove', () => {
  const conv = conventions();

  it('anyone who reports a bot bug can approve their own report, config or not', () => {
    // The whole team files these, including people not in conventions.users.
    const mine = proposal({ type: 'pm_agent_issue', requesterId: 'U0NEWBIE', payload: {} });
    assert.strictEqual(canApprove(mine, 'U0NEWBIE', conv), true);
    // ...but not someone else's, unless they are a lead.
    assert.strictEqual(canApprove(mine, 'U0OTHER', conv), false);
    assert.strictEqual(canApprove(mine, 'U0LEAD', conv), true);
  });

  it('an unconfigured user still cannot approve client work', () => {
    const clientTask = proposal({ type: 'task', requesterId: 'U0NEWBIE', payload: {} });
    assert.strictEqual(canApprove(clientTask, 'U0NEWBIE', conv), false);
  });

  it('requester (member) can approve their own task proposal', () => {
    const p = proposal({ type: 'task', payload: {} });
    assert.strictEqual(canApprove(p, 'U0MEMBER', conv), true);
  });

  it('leads can approve any proposal', () => {
    assert.strictEqual(canApprove(proposal({ type: 'task', payload: {} }), 'U0LEAD', conv), true);
    assert.strictEqual(canApprove(proposal({ type: 'scaffold', payload: {} }), 'U0LEAD', conv), true);
    assert.strictEqual(canApprove(proposal({ type: 'client_update', payload: {} }), 'U0LEAD', conv), true);
  });

  it('requester (member) can approve their own automation idea, unlike scaffolds/client updates', () => {
    assert.strictEqual(canApprove(proposal({ type: 'automation_idea', payload: {} }), 'U0MEMBER', conv), true);
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
