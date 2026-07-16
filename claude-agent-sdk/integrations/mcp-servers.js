import { getOAuthAccessToken } from './mcp-auth.js';

/**
 * Central config for the external MCP servers (ClickUp and Fireflies).
 *
 * Two consumers share this file:
 *  - the agent, which attaches these servers for READ-ONLY tool access
 *    (enforced by the explicit allowlist in agent/pixelup.js), and
 *  - the deterministic executor, which connects as an MCP *client* to run
 *    approved ClickUp writes (integrations/clickup-mcp.js).
 *
 * Auth is OAuth (run `npm run auth:<server>` once; tokens persist in
 * data/mcp-auth/ and refresh automatically). A static bearer token env var
 * remains as an override for servers that support API-key auth. The app
 * boots without either; unauthorized servers simply don't attach.
 */

export const CLICKUP_MCP = {
  key: 'clickup',
  urlEnv: 'CLICKUP_MCP_URL',
  tokenEnv: 'CLICKUP_MCP_TOKEN',
  defaultUrl: 'https://mcp.clickup.com/mcp',
};

export const FIREFLIES_MCP = {
  key: 'fireflies',
  urlEnv: 'FIREFLIES_MCP_URL',
  tokenEnv: 'FIREFLIES_MCP_TOKEN',
  defaultUrl: 'https://api.fireflies.ai/mcp',
};

/**
 * @param {{ urlEnv: string, defaultUrl: string }} server
 * @returns {string}
 */
export function serverUrl(server) {
  return process.env[server.urlEnv] || server.defaultUrl;
}

/**
 * Static bearer token override, when set.
 * @param {{ tokenEnv: string }} server
 * @returns {string | undefined}
 */
export function serverToken(server) {
  return process.env[server.tokenEnv] || undefined;
}

/**
 * Resolve a usable bearer token for a server: static env override first,
 * otherwise a (refreshed) OAuth access token from the store.
 * @param {{ key: string, urlEnv: string, tokenEnv: string, defaultUrl: string }} server
 * @returns {Promise<string | null>}
 */
export async function resolveBearerToken(server) {
  const staticToken = serverToken(server);
  if (staticToken) return staticToken;
  return getOAuthAccessToken(server, serverUrl(server));
}

/**
 * HTTP MCP server entry for the Claude Agent SDK's `mcpServers` option, or
 * null when the server is not authorized yet (the agent then runs without it).
 * @param {{ key: string, urlEnv: string, tokenEnv: string, defaultUrl: string }} server
 * @returns {Promise<{ type: 'http', url: string, headers: Record<string, string> } | null>}
 */
export async function agentServerConfig(server) {
  const token = await resolveBearerToken(server);
  if (!token) return null;
  return {
    type: 'http',
    url: serverUrl(server),
    headers: { Authorization: `Bearer ${token}` },
  };
}
