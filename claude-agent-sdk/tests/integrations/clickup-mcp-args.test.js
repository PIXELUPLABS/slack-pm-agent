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
});
