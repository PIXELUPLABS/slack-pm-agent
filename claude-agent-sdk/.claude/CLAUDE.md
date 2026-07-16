@../AGENTS.md

# Pixelup Bot — Spec

## What this is

A custom AI PM agent ("Pixelup Bot") living in the Pixelup Labs (design agency) Slack that handles repetitive project-management work between Slack, ClickUp, and Fireflies, so designers stay on design. Built on Slack's official agent template (Bolt + Claude Agent SDK), self-hosted, with our own lean ClickUp and Fireflies tools. Optimized for the cheapest viable setup: pay-per-use AI, prompt caching, lean custom tools instead of bloated MCP servers, no per-seat fees. The built-in Slackbot stays in use for pure Slack reading (thread summaries, meeting prep) at no cost; anything touching ClickUp or Fireflies goes to Pixelup Bot.

## Core workflows (Phase 1)

1. **Client task intake** — Client posts a request in their channel. A team member DMs Pixelup Bot ("add the design task [client] shared today"). The bot finds the message in the client channel, drafts the task (title, priority, deadline), resolves the correct client list, and quotes the client message it read so nothing gets misread. One tap to approve → task lands in ClickUp. Also available as a "…" message shortcut ("Add to ClickUp") on any message — same pipeline. The client sees nothing, ever.
2. **Client onboarding** — Engagement guidelines doc sent to the bot in a DM. It reads scope, deliverables, and timeline, cross-checks the Fireflies kickoff transcript for anything agreed verbally, and proposes the full project structure (lists, tasks, priorities, due dates). Review → approve → project live in ClickUp.
3. **QA rounds** — Designers drop QA comments in a Slack thread. When the round wraps, tag Pixelup Bot in the thread. It dedupes comments, structures them (page, device, severity), and creates them as tasks in the QA list with links back in the thread — after approval.
4. **Tue/Fri client updates** — Scheduled run pulls the week's ClickUp activity and internal channel context per client, drafts the update in the agency voice, and posts it to an internal drafts channel with an approve button. Nothing reaches a client without human sign-off; a human sends the approved draft.

Later phases: sync prep agendas, Fireflies action-item follow-through, timeline watchdog (Phase 2); agency-wide scaffolds, capacity/retainer reports, SOP lookups (Phase 3).

## Team access

Everyone can query ("what's on my plate today", "status of X"); answers are scoped per person via the Slack→ClickUp user mapping in config. Only leads can trigger client-facing drafts or project scaffolding — enforced in listener code by Slack user ID. The agent has no delete access at all.

## Architecture

- **Approval pipeline**: agent tools only *propose* writes as structured JSON → stored in `approvals/store.js` → rendered as a Block Kit approval card → `approvals/executor.js` (deterministic code) executes against ClickUp only after an authorized user taps Approve.
- **Integrations via MCP servers** (decision 2026-07-13, replacing hand-rolled REST/GraphQL): the ClickUp and Fireflies MCP servers attach to the agent for **read-only** tool access — an explicit named allowlist in `agent/pixelup.js`, no wildcards, so their create/update/delete/send tools are never exposed to the agent. Approved writes run through `integrations/clickup-mcp.js`, where the executor connects as an MCP *client* and calls named create/update tools deterministically. MCP tool names/arg shapes must be verified against the live servers (`npm run auth:*` prints them).
- **MCP auth is OAuth** (decision 2026-07-13): `npm run auth:clickup` / `npm run auth:fireflies` run the one-time browser flow (PKCE + dynamic client registration via the MCP SDK); tokens persist in `data/mcp-auth/` (gitignored, mode 0600) and refresh automatically (`integrations/mcp-auth.js`). Static `*_MCP_TOKEN` env vars remain as overrides. Unauthorized servers don't attach; the executor fails with a pointer to the auth script.
- **Config**: `config/conventions.json` + `config/index.js` loader — clients→list mapping, priorities, naming, statuses, Slack↔ClickUp user mapping, roles, drafts channel, update schedule. Single source of truth, loaded at startup.
- **Agent**: `agent/pixelup.js` — `runPixelupAgent()`, system prompt + conventions summary built once at module load (stable for prompt caching), `maxTurns` capped.
- **Client-channel guard**: listener code drops any event that would make the bot respond in a configured client channel.
- **Token efficiency**: stable cacheable system prompt, read-only MCP allowlist kept lean (unallowed tools stay out of the loop), deterministic (zero-LLM) path for the message shortcut, capped turns.
- **No credentials required to boot**: the app starts and runs without `ANTHROPIC_API_KEY` or MCP authorization; unauthorized MCP servers simply don't attach and writes fail with clear errors until `npm run auth:*` is completed.

## Hard rules (never violate)

- The bot NEVER posts messages in client channels. No tool may do so.
- Every ClickUp write (create/update) is proposed as structured JSON, shown to the user
  as a Block Kit approval card, and executed by deterministic code ONLY after approval.
  The agent never calls write tools directly.
- No delete capabilities, anywhere, ever.
- Permission checks (who can trigger client-facing drafts / scaffolding) are enforced
  in listener code by Slack user ID against config — never via the system prompt.
- Model is pinned to claude-sonnet-5 in code. Simple parsing tasks route to Haiku later.
- All conventions (client→list mapping, priorities, naming, user mapping) live in
  config/conventions.json — single source of truth, loaded at startup.
- Keep the Bolt listener structure and thread-context session store from the template.
