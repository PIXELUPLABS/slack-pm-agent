import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  conventionsSummary,
  findClientByChannel,
  formatTaskName,
  getClickUpUserId,
  isClientChannel,
  isConversationChannel,
  isLead,
  loadConventions,
  resolvePriority,
  validateConventions,
} from '../../config/index.js';

function validData() {
  return {
    agency: { name: 'Pixelup Labs', voice: 'Direct.' },
    clickup: {
      task_name_format: '[{client}] {title}',
      priorities: { urgent: 1, high: 2, normal: 3, low: 4 },
      default_priority: 'normal',
      statuses: ['to do', 'done'],
      default_status: 'to do',
    },
    clients: {
      acme: {
        display_name: 'Acme',
        channel_id: 'C0ACME',
        internal_channel_id: 'C0ACMEINT',
        list_id: 'L1',
        qa_list_id: 'L2',
        folder_id: 'F1',
      },
    },
    users: {
      U0LEAD: { name: 'Lead', clickup_user_id: 1, role: 'lead' },
      U0MEMBER: { name: 'Member', clickup_user_id: 2, role: 'member' },
    },
    channels: { drafts_channel_id: 'C0DRAFTS' },
    client_updates: { enabled: false, days: ['tuesday', 'friday'], hour: 9, minute: 0, timezone: 'UTC' },
  };
}

describe('validateConventions', () => {
  it('accepts a valid config', () => {
    assert.deepStrictEqual(validateConventions(validData()), validData());
  });

  it('rejects a missing section', () => {
    const data = validData();
    delete data.users;
    assert.throws(() => validateConventions(data), /missing or invalid "users"/);
  });

  it('rejects an invalid role', () => {
    const data = validData();
    data.users.U0LEAD.role = 'admin';
    assert.throws(() => validateConventions(data), /role must be/);
  });

  it('rejects a client with missing fields', () => {
    const data = validData();
    delete data.clients.acme.list_id;
    assert.throws(() => validateConventions(data), /clients\.acme\.list_id/);
  });

  it('rejects an invalid schedule day', () => {
    const data = validData();
    data.client_updates.days = ['tuesday', 'someday'];
    assert.throws(() => validateConventions(data), /invalid day "someday"/);
  });

  it('rejects a default priority not in priorities', () => {
    const data = validData();
    data.clickup.default_priority = 'blocker';
    assert.throws(() => validateConventions(data), /default_priority/);
  });
});

describe('loadConventions', () => {
  it('loads and validates the checked-in conventions.json', () => {
    const conventions = loadConventions();
    assert.ok(conventions.agency.name);
    assert.ok(Object.keys(conventions.clients).length > 0);
  });
});

describe('helpers', () => {
  const conventions = validateConventions(validData());

  it('findClientByChannel resolves a client channel', () => {
    assert.strictEqual(findClientByChannel(conventions, 'C0ACME')?.key, 'acme');
    assert.strictEqual(findClientByChannel(conventions, 'C0OTHER'), null);
  });

  it('isClientChannel is true only for client channels', () => {
    assert.strictEqual(isClientChannel(conventions, 'C0ACME'), true);
    assert.strictEqual(isClientChannel(conventions, 'C0DRAFTS'), false);
  });

  it('isConversationChannel allows only internal + drafts channels (default-deny)', () => {
    assert.strictEqual(isConversationChannel(conventions, 'C0ACMEINT'), true);
    assert.strictEqual(isConversationChannel(conventions, 'C0DRAFTS'), true);
    assert.strictEqual(isConversationChannel(conventions, 'C0ACME'), false); // client channel
    assert.strictEqual(isConversationChannel(conventions, 'C0RANDOM'), false); // unmapped channel
    assert.strictEqual(isConversationChannel(conventions, ''), false);
  });

  it('isLead follows config roles', () => {
    assert.strictEqual(isLead(conventions, 'U0LEAD'), true);
    assert.strictEqual(isLead(conventions, 'U0MEMBER'), false);
    assert.strictEqual(isLead(conventions, 'U0STRANGER'), false);
  });

  it('getClickUpUserId maps Slack to ClickUp', () => {
    assert.strictEqual(getClickUpUserId(conventions, 'U0LEAD'), 1);
    assert.strictEqual(getClickUpUserId(conventions, 'U0STRANGER'), null);
  });

  it('resolvePriority maps names and falls back to default', () => {
    assert.strictEqual(resolvePriority(conventions, 'urgent'), 1);
    assert.strictEqual(resolvePriority(conventions, undefined), 3);
    assert.strictEqual(resolvePriority(conventions, 'nonsense'), 3);
  });

  it('formatTaskName applies the naming convention', () => {
    assert.strictEqual(formatTaskName(conventions, 'acme', 'Fix header'), '[Acme] Fix header');
  });

  it('conventionsSummary has client keys and team IDs but no list/channel IDs', () => {
    const summary = conventionsSummary(conventions);
    assert.ok(summary.includes('acme'));
    assert.ok(summary.includes('Slack U0LEAD'));
    assert.ok(summary.includes('ClickUp 1'));
    assert.ok(!summary.includes('L1'));
    assert.ok(!summary.includes('C0ACME'));
  });
});
