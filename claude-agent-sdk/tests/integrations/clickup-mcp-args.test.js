import assert from 'node:assert';
import { describe, it } from 'node:test';

import { toMcpTaskArgs } from '../../integrations/clickup-mcp.js';

describe('toMcpTaskArgs', () => {
  it('maps executor fields to the verified MCP argument shape', () => {
    const args = toMcpTaskArgs({
      name: 'Fix header',
      description: 'From client thread',
      priority: 2,
      start_date: Date.parse('2026-07-13'),
      due_date: Date.parse('2026-07-20'),
      assignees: [22],
      status: 'to do',
    });
    assert.deepStrictEqual(args, {
      name: 'Fix header',
      markdown_description: 'From client thread',
      priority: 'high',
      start_date: '2026-07-13',
      due_date: '2026-07-20',
      // ClickUp MCP validates assignees as strings (verified live 2026-07-14).
      assignees: ['22'],
      status: 'to do',
    });
  });

  it('maps every numeric priority to its ClickUp name', () => {
    assert.strictEqual(toMcpTaskArgs({ priority: 1 }).priority, 'urgent');
    assert.strictEqual(toMcpTaskArgs({ priority: 2 }).priority, 'high');
    assert.strictEqual(toMcpTaskArgs({ priority: 3 }).priority, 'normal');
    assert.strictEqual(toMcpTaskArgs({ priority: 4 }).priority, 'low');
  });

  it('omits absent fields entirely', () => {
    assert.deepStrictEqual(toMcpTaskArgs({ name: 'x' }), { name: 'x' });
  });

  it('drops non-array assignees and empty arrays', () => {
    assert.strictEqual(toMcpTaskArgs({ assignees: /** @type {any} */ ('22') }).assignees, undefined);
    assert.strictEqual(toMcpTaskArgs({ assignees: [] }).assignees, undefined);
  });

  it('clears assignees when clear_assignees is set', () => {
    assert.deepStrictEqual(toMcpTaskArgs({ clear_assignees: true }).assignees, []);
  });

  it('clear_assignees overrides any assignees list', () => {
    assert.deepStrictEqual(toMcpTaskArgs({ clear_assignees: true, assignees: [22] }).assignees, []);
  });

  it('maps parent, tags, and time_estimate (minutes as a string)', () => {
    const args = toMcpTaskArgs({ parent: 'p1', tags: ['a', 'b'], time_estimate: 150 });
    assert.strictEqual(args.parent, 'p1');
    assert.deepStrictEqual(args.tags, ['a', 'b']);
    assert.strictEqual(args.time_estimate, '150');
  });

  it('omits empty tags', () => {
    assert.strictEqual(toMcpTaskArgs({ tags: [] }).tags, undefined);
  });
});
