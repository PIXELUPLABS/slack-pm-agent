import assert from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

import * as clickupMcp from '../../integrations/clickup-mcp.js';
import { agentServerConfig, CLICKUP_MCP, FIREFLIES_MCP, serverUrl } from '../../integrations/mcp-servers.js';

// Hermetic: never let tests read real OAuth tokens (and reach live servers).
process.env.MCP_AUTH_DIR = '/nonexistent-mcp-auth-for-tests';
after(() => {
  delete process.env.MCP_AUTH_DIR;
});

describe('clickup-mcp integration', () => {
  beforeEach(() => {
    delete process.env.CLICKUP_MCP_TOKEN;
    delete process.env.CLICKUP_MCP_URL;
  });

  it('exposes no delete capability of any kind', () => {
    const exported = Object.keys(clickupMcp);
    assert.ok(exported.length > 0);
    for (const name of exported) {
      assert.ok(!/delete|remove|archive/i.test(name), `unexpected destructive export: ${name}`);
    }
  });

  it('createTask fails clearly when the server is not authorized', async () => {
    await assert.rejects(() => clickupMcp.createTask('L1', { name: 'x' }), /npm run auth:clickup/);
  });

  it('updateTask fails clearly when the server is not authorized', async () => {
    await assert.rejects(() => clickupMcp.updateTask('t1', { name: 'x' }), /npm run auth:clickup/);
  });

  it('extractTaskRef parses JSON responses', () => {
    const ref = clickupMcp.extractTaskRef(
      JSON.stringify({ task: { id: 'abc123', url: 'https://app.clickup.com/t/abc123' } }),
    );
    assert.strictEqual(ref.id, 'abc123');
    assert.strictEqual(ref.url, 'https://app.clickup.com/t/abc123');
  });

  it('extractTaskRef falls back to regex on plain text', () => {
    const ref = clickupMcp.extractTaskRef('Created task "id": "xyz789" at https://app.clickup.com/t/xyz789 ok');
    assert.strictEqual(ref.id, 'xyz789');
    assert.strictEqual(ref.url, 'https://app.clickup.com/t/xyz789');
  });

  it('extractTaskRef handles the live create-list response shape (list_id/list_url)', () => {
    const ref = clickupMcp.extractTaskRef(
      '{"success":true,"list_id":"901615878054","list_url":"https://app.clickup.com/90161553384/v/l/li/901615878054"}',
    );
    assert.strictEqual(ref.id, '901615878054');
    assert.strictEqual(ref.url, 'https://app.clickup.com/90161553384/v/l/li/901615878054');
  });
});

describe('mcp-servers config', () => {
  beforeEach(() => {
    delete process.env.CLICKUP_MCP_TOKEN;
    delete process.env.CLICKUP_MCP_URL;
    delete process.env.FIREFLIES_MCP_TOKEN;
  });

  it('agentServerConfig returns null when neither OAuth nor a static token exists', async () => {
    assert.strictEqual(await agentServerConfig(CLICKUP_MCP), null);
    assert.strictEqual(await agentServerConfig(FIREFLIES_MCP), null);
  });

  it('agentServerConfig builds an http server entry from a static token override', async () => {
    process.env.CLICKUP_MCP_TOKEN = 'secret';
    const config = await agentServerConfig(CLICKUP_MCP);
    assert.strictEqual(config?.type, 'http');
    assert.strictEqual(config?.url, 'https://mcp.clickup.com/mcp');
    assert.strictEqual(config?.headers.Authorization, 'Bearer secret');
  });

  it('serverUrl honors env overrides', () => {
    process.env.CLICKUP_MCP_URL = 'https://example.com/mcp';
    assert.strictEqual(serverUrl(CLICKUP_MCP), 'https://example.com/mcp');
  });
});
