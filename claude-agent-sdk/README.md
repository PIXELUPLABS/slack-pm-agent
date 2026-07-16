# PIXELUP LABS Agent

An AI project-management agent for the Pixelup Labs Slack, built with [Bolt for JavaScript](https://tools.slack.dev/bolt-js/) and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). It handles the PM busywork between Slack, ClickUp, and Fireflies — task intake, project scaffolds, QA rounds, and client update drafts — all approval-gated.

For the plain-language guide to how the bot works, what it costs, and how to customize it, see [OWNERS-GUIDE.md](./OWNERS-GUIDE.md). For architecture and development conventions, see [AGENTS.md](./AGENTS.md).

## App Overview

The agent works through four entry points:

* **Direct Messages** — DM the bot ("add the design task Monumint shared today", "what's on my plate this week"). It responds in-thread and keeps context across follow-ups.
* **Message shortcut** — Use _Add to ClickUp_ from any message's `…` menu to draft a ClickUp task from it for approval.
* **Channel @mentions** — Tag the bot in an internal thread (e.g. at the end of a QA round) and it structures the thread into proposed tasks. It never responds in client channels.
* **App Home** — Category buttons open a modal for describing a request; the bot follows up in a DM thread.

### Safety model

* Every ClickUp write is proposed as structured JSON, shown as an Approve/Reject card, and executed by deterministic code (`approvals/executor.js`) only after an authorized user approves. The agent cannot call write tools directly.
* ClickUp and Fireflies attach as **read-only** MCP servers via an explicit tool allowlist — their write and delete tools are never exposed to the agent.
* No delete capability exists anywhere.
* Role checks are enforced in listener code by Slack user ID against `config/conventions.json`.

## Setup

### Create the Slack app

1. Open [https://api.slack.com/apps/new](https://api.slack.com/apps/new) and choose "From an app manifest"
2. Choose the workspace to install the app to
3. Copy the contents of [manifest.json](./manifest.json) into the JSON tab and click _Next_
4. Review the configuration and click _Create_
5. Click _Install to Workspace_ and _Allow_

### Environment variables

1. Rename `.env.sample` to `.env`.
2. From your [app settings](https://api.slack.com/apps): copy the _Bot User OAuth Token_ (under _OAuth & Permissions_) into `.env` as `SLACK_BOT_TOKEN`.
3. Under _Basic Information_ → _App-Level Tokens_, create a token with the `connections:write` scope and copy it into `.env` as `SLACK_APP_TOKEN`.
4. Create an API key from your [Anthropic dashboard](https://console.anthropic.com/settings/keys) and save it as `ANTHROPIC_API_KEY`.

See [AGENTS.md](./AGENTS.md#environment-variables) for the full variable reference.

### Install dependencies and authorize MCP servers

```sh
npm install
npm run auth:clickup     # One-time OAuth sign-in for the ClickUp MCP server
npm run auth:fireflies   # One-time OAuth sign-in for the Fireflies MCP server
```

The `auth:*` scripts walk a browser OAuth flow once, save tokens to `data/mcp-auth/` (gitignored), and the bot refreshes them automatically. The app boots and runs without `ANTHROPIC_API_KEY` or MCP authorization — unauthorized servers simply don't attach, and writes fail with clear errors pointing at the auth scripts.

### Start the app

```sh
npm start
```

Or with the [Slack CLI](https://docs.slack.dev/tools/slack-cli/):

```sh
slack run
```

<details><summary><strong>OAuth HTTP mode (with ngrok)</strong></summary>

`app-oauth.js` runs the app as an HTTP server instead of Socket Mode, for OAuth-based distribution.

1. Install [ngrok](https://ngrok.com/download) and start a tunnel:

```sh
ngrok http 3000
```

2. In `manifest.json`, set `socket_mode_enabled` to `false` and replace the request URLs with your ngrok domain.
3. From app settings, copy **Client ID**, **Client Secret**, and **Signing Secret** into `.env`, and set `SLACK_REDIRECT_URI` to `https://YOUR_NGROK_SUBDOMAIN.ngrok-free.app/slack/oauth_redirect`.
4. Start the app and open the install URL printed in the terminal:

```sh
node app-oauth.js
```

> **Note:** Each time ngrok restarts it generates a new URL — update `manifest.json` and `SLACK_REDIRECT_URI`, then re-install the app.

</details>

## Development

```sh
npm run lint         # Biome lint and format check
npm run lint:fix     # Auto-fix lint and format issues
npm run check        # Type check JavaScript with tsc (checkJs)
npm test             # Run unit tests (Node.js built-in test runner)
```

## Project structure

| Path | Purpose |
|------|---------|
| `app.js` | Entry point (Socket Mode) |
| `app-oauth.js` | Alternative entry point (HTTP mode, OAuth distribution) |
| `manifest.json` | Slack app configuration |
| `agent/` | `pixelup.js` (agent + system prompt) and `tools/` (tool factories) |
| `approvals/` | Proposal store, Block Kit card builder, deterministic executor |
| `config/` | `conventions.json` (single source of truth) + validated loader |
| `integrations/` | MCP server config, OAuth token store, executor's ClickUp write client |
| `listeners/` | Bolt listeners: `events/`, `actions/`, `shortcuts/`, `views/` |
| `schedules/` | Tue/Fri client-update draft scheduler |
| `scripts/` | One-time interactive MCP OAuth flow |
| `thread-context/` | `SessionStore` for Claude session IDs |
| `tests/` | Unit tests mirroring the source structure |

## Slack MCP Server

When deployed with OAuth (HTTP mode), the agent also connects to the [Slack MCP Server](https://docs.slack.dev/ai/slack-mcp-server) using the user's token, adding message search, channel history, and canvas capabilities.

### Troubleshooting: `App is not enabled for Slack MCP server access`

If you see an error like:

```
Error: Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"App is not enabled for Slack MCP server access. ..."}}
```

the Slack MCP feature has not been enabled for the app. There is no manifest property for this, so toggle it manually:

1. Open your app's settings at [api.slack.com/apps](https://api.slack.com/apps)
2. Navigate to **Agents & AI Apps** in the left-side navigation
3. Toggle **Slack Model Context Protocol** on
