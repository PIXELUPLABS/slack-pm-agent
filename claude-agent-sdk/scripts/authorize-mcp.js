import { createServer } from 'node:http';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FileOAuthProvider } from '../integrations/mcp-auth.js';
import { CLICKUP_MCP, FIREFLIES_MCP, serverUrl } from '../integrations/mcp-servers.js';

/**
 * One-time interactive OAuth authorization for an external MCP server.
 *
 *   npm run auth:clickup
 *   npm run auth:fireflies
 *
 * Walks discovery → dynamic client registration → browser sign-in (PKCE) →
 * token exchange, persists tokens to data/mcp-auth/<server>.json, then
 * verifies by listing the server's tools. The bot refreshes tokens
 * automatically from then on; re-run this only if refresh stops working.
 */

const SERVERS = { clickup: CLICKUP_MCP, fireflies: FIREFLIES_MCP };
const CALLBACK_PORT = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT || '8976', 10);
const CALLBACK_PATH = '/callback';

/** @param {string} url @returns {void} */
function tryOpenBrowser(url) {
  // Best-effort convenience; the URL is printed either way.
  import('node:child_process').then(({ exec }) => exec(`open "${url.replace(/"/g, '%22')}"`)).catch(() => {});
}

/**
 * Wait for the OAuth redirect and capture the authorization code.
 * @returns {Promise<string>}
 */
function waitForAuthorizationCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        code
          ? '<h3>Authorized — you can close this tab and return to the terminal.</h3>'
          : `<h3>Authorization failed: ${error || 'no code returned'}</h3>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(`Authorization failed: ${error || 'no code returned'}`));
    });
    server.on('error', reject);
    server.listen(CALLBACK_PORT);
  });
}

/**
 * Connect with the stored tokens and list tools to prove auth works.
 * @param {FileOAuthProvider} provider
 * @param {string} url
 * @returns {Promise<string[]>}
 */
async function verify(provider, url) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  const client = new Client({ name: 'pixelup-bot-authorize', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    return result.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const key = process.argv[2];
  const server = SERVERS[key];
  if (!server) {
    console.error(`Usage: node scripts/authorize-mcp.js <${Object.keys(SERVERS).join('|')}>`);
    process.exit(1);
  }

  const url = serverUrl(server);
  console.log(`Authorizing ${key} MCP server at ${url} …`);

  /** @type {Promise<string> | null} */
  let codePromise = null;
  const provider = new FileOAuthProvider(key, {
    redirectUrl: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
    onRedirect: (authorizationUrl) => {
      codePromise = waitForAuthorizationCode();
      console.log('\nOpen this URL in your browser to sign in:\n');
      console.log(`  ${authorizationUrl}\n`);
      tryOpenBrowser(String(authorizationUrl));
    },
  });

  let result = await auth(provider, { serverUrl: url });
  if (result === 'REDIRECT') {
    if (!codePromise) throw new Error('Expected an authorization redirect but none was initiated.');
    const code = await codePromise;
    result = await auth(provider, { serverUrl: url, authorizationCode: code });
  }
  if (result !== 'AUTHORIZED') {
    throw new Error(`Authorization did not complete (result: ${result}).`);
  }

  console.log('Tokens saved. Verifying by listing tools…');
  const toolNames = await verify(provider, url);
  console.log(`\n✔ ${key} MCP authorized. ${toolNames.length} tool(s) available:`);
  for (const name of toolNames.sort()) console.log(`  - ${name}`);
  console.log(
    '\nCompare these names against the read allowlist in agent/pixelup.js and the write tool names in integrations/clickup-mcp.js.',
  );
}

main().catch((e) => {
  console.error(`\n✖ ${e.message || e}`);
  process.exit(1);
});
