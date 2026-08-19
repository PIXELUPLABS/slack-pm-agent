# AGENTS.md - claude-agent-sdk

JavaScript implementation of Pixelup Bot using the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`).

See the [root AGENTS.md](../AGENTS.md) for monorepo-wide architecture and shared patterns, and `.claude/CLAUDE.md` for the product spec and hard rules.

## Setup

```sh
cp .env.sample .env   # Fill in ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN
npm install
npm run auth:clickup     # One-time OAuth sign-in for the ClickUp MCP server
npm run auth:fireflies   # One-time OAuth sign-in for the Fireflies MCP server
npm start
```

MCP auth is OAuth (PKCE + dynamic client registration): the `auth:*` scripts walk the browser flow once, save tokens to `data/mcp-auth/` (gitignored), and the bot refreshes them automatically. The app boots and runs without `ANTHROPIC_API_KEY` or MCP authorization — unauthorized servers don't attach and writes fail with clear errors pointing at the auth scripts.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLICKUP_MCP_TOKEN` | Optional static bearer override (skips OAuth for ClickUp) |
| `CLICKUP_MCP_URL` | Optional override (default `https://mcp.clickup.com/mcp`) |
| `FIREFLIES_MCP_TOKEN` | Optional static bearer override (skips OAuth for Fireflies) |
| `FIREFLIES_MCP_URL` | Optional override (default `https://api.fireflies.ai/mcp`) |
| `TLDV_API_KEY` | Optional; enables `read_link` on tl;dv meeting links (tl;dv → Settings → API keys, Pro/Business plan) |
| `TLDV_API_URL` | Optional override (default `https://pasta.tldv.io/v1alpha1`) |
| `DOCUMENT_MODEL` | Optional override for PDF reading (default `claude-sonnet-5`, the agent's pinned model) |
| `MCP_OAUTH_CALLBACK_PORT` | Localhost callback port for `npm run auth:*` (default 8976) |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-`) for Socket Mode |
| `SLACK_CLIENT_ID` | OAuth client ID (for `app-oauth.js`) |
| `SLACK_CLIENT_SECRET` | OAuth client secret (for `app-oauth.js`) |
| `SLACK_SIGNING_SECRET` | Signing secret (for `app-oauth.js`) |
| `SLACK_REDIRECT_URI` | OAuth redirect URI (for `app-oauth.js`) |

## Commands

```sh
npm install          # Install dependencies
npm start            # Start the app
npm run auth:clickup    # One-time OAuth flow for the ClickUp MCP server
npm run auth:fireflies  # One-time OAuth flow for the Fireflies MCP server
npm run brief:coverage  # Which internal channels can the bot read? (free — no history reads, no model call)
npm run brief           # Build today's brief and print it (sends nothing)
npm run brief -- --weekly   # Build Monday's weekly review on any day (one model call per active channel, plus one)
npm run brief -- --daily    # Force the daily brief, even on the weekly review day
npm run brief -- --weekly --digest   # ...and print the per-channel summaries handed to the reduce call
npm run brief -- --dm   # ...and DM it to daily_brief.recipient_slack_id
npm run brief -- --dm U09RKSU0QSX   # preview someone else's brief; "Needs you" stays anchored on the configured recipient
npm run lint         # Biome lint and format check
npm run lint:fix     # Auto-fix lint and format issues
npm run check        # Type check JavaScript with tsc (checkJs)
```

## Testing

Tests use the Node.js built-in test runner (`node:test`) and assertion module (`node:assert`).

```sh
npm test             # Run all tests
```

### Conventions

- Test files live in `tests/` and mirror the source directory structure
- File naming: `<source-file>.test.js` (not `.spec.js`)
- Use `describe()` / `it()` / `beforeEach()` blocks from `node:test`
- Use `mock.fn()` from `node:test` for mocking — no external mock libraries
- Assertions use `node:assert` (`strictEqual`, `ok`, `deepStrictEqual`)
- Mock Slack client methods as `mock.fn()` objects with the needed nested structure
- Test files use ES module `import` statements (`"type": "module"`)
- No test may hit the network; integration modules are covered via missing-token error paths and injected fakes

## Architecture

### Folder map

| Directory | Purpose |
|-----------|---------|
| `agent/` | `pixelup.js` (agent + system prompt) and `tools/` (tool factories) |
| `approvals/` | Proposal store, Block Kit card builder, deterministic executor |
| `config/` | `conventions.json` (non-derivable conventions + per-client overrides), validated loader/helpers, and `resolver.js` (runtime channel↔client and client→ClickUp resolution, memoized) |
| `integrations/` | MCP server config (`mcp-servers.js`), OAuth provider/token store (`mcp-auth.js`), executor's MCP write client (`clickup-mcp.js`), document text extraction (`document-reader.js`), tl;dv read client (`tldv.js`) |
| `scripts/` | `authorize-mcp.js` — one-time interactive OAuth flow (also prints the server's real tool names) |
| `listeners/` | Bolt listeners: `events/`, `actions/`, `shortcuts/`, `views/` |
| `schedules/` | Tue/Fri client-update draft scheduler; weekday founder brief and Monday weekly review (`daily-brief.js`, two modes off one pipeline) |
| `thread-context/` | `SessionStore` for Claude session IDs |

### Agent Layer

The agent is defined in `agent/pixelup.js`:

- `runPixelupAgent(text, sessionId, deps)` wraps `query()` from the SDK
- Model pinned to `claude-sonnet-5`; `maxTurns` capped to bound token spend
- System prompt + conventions summary are built once at module load so the prompt stays stable for Anthropic prompt caching
- Local tools are factories in `agent/tools/` wrapped in an in-process MCP server (`pixelup-tools`) via `createSdkMcpServer()`
- ClickUp and Fireflies attach as external HTTP MCP servers when their tokens are set; the agent may only call the **read-only tools named in the allowlist** (no wildcards) — every write/delete tool those servers expose is denied
- `permissionMode: 'default'` + explicit `allowedTools` is the enforcement mechanism; do not switch to `bypassPermissions` (it would unlock external write/delete tools)

### Approval pipeline

Agent `propose_*` tool → structured JSON in `approvals/store.js` → Block Kit card (`approvals/card-builder.js`) → Approve/Reject buttons (`listeners/actions/approval-buttons.js`, permission-checked against config roles) → `approvals/executor.js` performs the ClickUp write deterministically via `integrations/clickup-mcp.js` (an MCP client calling named create/update tools — no delete calls exist). Client updates execute as a no-op: approval marks the draft ready for a human to send. Two proposal types write to Slack rather than ClickUp — `canvas_update` (channel canvas) and `channel_message` (a plain message in an internal channel, for reminders and heads-ups). Both re-check `canBotPostInChannel` in the executor, and `channel_message` renders its `<@ID>` mentions there from IDs code validated at propose time.

### Conversation Management

`thread-context/store.js` exports a `SessionStore` that stores **session IDs only** (not full message history). The Claude Agent SDK manages conversation history server-side. The store passes `{ resume: sessionId }` on subsequent turns to continue a conversation.

The store uses a `Map` keyed by `${channelId}:${threadTs}` with TTL-based cleanup and a max entry limit. `approvals/store.js` follows the same pattern for proposals.

### Permission & safety gates (in code, never in the prompt)

- `listeners/events/*` drop any event in a client-facing channel — the bot never posts there. The check is `canBotPostInChannel` (`config/resolver.js`): by channel name (`{client}-pixelup`), not by config ID, and fail-closed on an unidentifiable channel. Requires `channels:read`/`groups:read`
- Writes need a registered client: `propose_*` refuses an unknown client key and points at `propose_client_registration` (lead-only)
- `propose_project_scaffold` / `propose_client_update` require the `lead` role
- Approval buttons re-check roles before executing
- The agent's external MCP allowlist is read-only; `integrations/clickup-mcp.js` implements no delete call
- `read_link` fetches http(s) only and refuses private/internal addresses — re-checked after redirects, so a public URL cannot redirect into the private range. Everything it and `read_shared_file` return is wrapped as untrusted data, never instructions

### Tool Definitions

Tools are created by factories in `agent/tools/` using `tool()` from the Claude Agent SDK with Zod v4 schemas, returning MCP `CallToolResult` format:

```js
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export function createMyTools(deps, conventions) {
  return [
    tool('tool_name', 'Terse description.', { query: z.string() }, async (args) => ({
      content: [{ type: 'text', text: 'result' }],
    })),
  ];
}
```
