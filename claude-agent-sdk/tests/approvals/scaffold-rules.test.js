import assert from 'node:assert';
import { describe, it } from 'node:test';

import { applyDueDatePriorities, resolveStage } from '../../approvals/scaffold-rules.js';
import { validateConventions } from '../../config/index.js';

const conventions = validateConventions({
  agency: { name: 'Pixelup Labs', voice: 'Direct.' },
  clickup: {
    task_name_format: '{title}',
    priorities: { urgent: 1, high: 2, normal: 3, low: 4 },
    default_priority: 'normal',
    statuses: ['new', 'done'],
    default_status: 'new',
    project_stage_field: {
      id: 'field-1',
      options: {
        planning: 'opt-planning',
        'visual design': 'opt-design',
        content: 'opt-content',
        dev: 'opt-dev',
        qa: 'opt-qa',
      },
    },
  },
  clients: {},
  users: {},
  channels: { drafts_channel_id: '' },
  client_updates: { enabled: false, days: [], hour: 9, minute: 0, timezone: 'UTC' },
});

describe('applyDueDatePriorities', () => {
  it('closest due date is urgent, second high, rest low', () => {
    const tasks = [
      { title: 'c', dueDate: '2026-08-08' },
      { title: 'a', dueDate: '2026-07-11' },
      { title: 'b', dueDate: '2026-07-18' },
      { title: 'undated' },
    ];
    applyDueDatePriorities(tasks);
    assert.strictEqual(tasks.find((t) => t.title === 'a').priority, 'urgent');
    assert.strictEqual(tasks.find((t) => t.title === 'b').priority, 'high');
    assert.strictEqual(tasks.find((t) => t.title === 'c').priority, 'low');
    assert.strictEqual(tasks.find((t) => t.title === 'undated').priority, 'low');
  });

  it('overwrites model-proposed priorities', () => {
    const tasks = [{ title: 'only', dueDate: '2026-07-11', priority: 'normal' }];
    applyDueDatePriorities(tasks);
    assert.strictEqual(tasks[0].priority, 'urgent');
  });

  it('handles all-undated task lists', () => {
    const tasks = [{ title: 'x' }, { title: 'y' }];
    applyDueDatePriorities(tasks);
    assert.ok(tasks.every((t) => t.priority === 'low'));
  });
});

describe('endOfWeek', () => {
  it('resolves to the Friday of the current working week', async () => {
    const { endOfWeek } = await import('../../approvals/scaffold-rules.js');
    // 2026-07-17 is a Friday, so Mon 13th → Fri 17th across the week.
    assert.strictEqual(endOfWeek(new Date('2026-07-13T09:00:00Z')), '2026-07-17'); // Monday
    assert.strictEqual(endOfWeek(new Date('2026-07-15T23:30:00Z')), '2026-07-17'); // Wednesday
    assert.strictEqual(endOfWeek(new Date('2026-07-17T08:00:00Z')), '2026-07-17'); // Friday itself
  });

  it('rolls the weekend forward to the coming Friday', async () => {
    const { endOfWeek } = await import('../../approvals/scaffold-rules.js');
    assert.strictEqual(endOfWeek(new Date('2026-07-18T10:00:00Z')), '2026-07-24'); // Saturday
    assert.strictEqual(endOfWeek(new Date('2026-07-19T10:00:00Z')), '2026-07-24'); // Sunday
  });
});

describe('weekend date snapping', () => {
  it('due dates on Sat/Sun snap back to Friday', async () => {
    const { snapDueDateToWeekday } = await import('../../approvals/scaffold-rules.js');
    // 2026-07-18 is a Saturday, 2026-07-19 a Sunday, 2026-07-17 the Friday before.
    assert.strictEqual(snapDueDateToWeekday('2026-07-18'), '2026-07-17');
    assert.strictEqual(snapDueDateToWeekday('2026-07-19'), '2026-07-17');
  });

  it('weekday due dates are untouched', async () => {
    const { snapDueDateToWeekday } = await import('../../approvals/scaffold-rules.js');
    assert.strictEqual(snapDueDateToWeekday('2026-07-17'), '2026-07-17'); // Friday
    assert.strictEqual(snapDueDateToWeekday('2026-07-15'), '2026-07-15'); // Wednesday
  });

  it('start dates on Sat/Sun snap forward to Monday', async () => {
    const { snapStartDateToWeekday } = await import('../../approvals/scaffold-rules.js');
    assert.strictEqual(snapStartDateToWeekday('2026-07-18'), '2026-07-20');
    assert.strictEqual(snapStartDateToWeekday('2026-07-19'), '2026-07-20');
    assert.strictEqual(snapStartDateToWeekday('2026-07-20'), '2026-07-20'); // Monday
  });

  it('passes through undefined and invalid dates', async () => {
    const { snapDueDateToWeekday, snapStartDateToWeekday } = await import('../../approvals/scaffold-rules.js');
    assert.strictEqual(snapDueDateToWeekday(undefined), undefined);
    assert.strictEqual(snapStartDateToWeekday('not-a-date'), 'not-a-date');
  });
});

describe('resolveStage', () => {
  it('matches exact and fuzzy names case-insensitively', () => {
    assert.strictEqual(resolveStage(conventions, 'planning')?.optionId, 'opt-planning');
    assert.strictEqual(resolveStage(conventions, 'Visual Design')?.optionId, 'opt-design');
    assert.strictEqual(resolveStage(conventions, 'design')?.optionId, 'opt-design');
    assert.strictEqual(resolveStage(conventions, 'QA')?.optionId, 'opt-qa');
  });

  it('returns null for unknown stages or missing config', () => {
    assert.strictEqual(resolveStage(conventions, 'shipping'), null);
    assert.strictEqual(resolveStage(conventions, undefined), null);
    const noField = { ...conventions, clickup: { ...conventions.clickup, project_stage_field: undefined } };
    assert.strictEqual(resolveStage(noField, 'planning'), null);
  });
});
