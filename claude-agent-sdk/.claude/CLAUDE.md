@../AGENTS.md

# Pixelup Bot — Spec

## What this is

A custom AI PM agent ("Pixelup Bot") living in the Pixelup Labs (design agency) Slack that handles repetitive project-management work between Slack, ClickUp, and Fireflies, so designers stay on design. Built on Slack's official agent template (Bolt + Claude Agent SDK), self-hosted, with our own lean ClickUp and Fireflies tools. Optimized for the cheapest viable setup: pay-per-use AI, prompt caching, lean custom tools instead of bloated MCP servers, no per-seat fees. The built-in Slackbot stays in use for pure Slack reading (thread summaries, meeting prep) at no cost; anything touching ClickUp or Fireflies goes to Pixelup Bot.

## Core workflows (Phase 1)

1. **Client task intake** — Client posts a request in their channel. A team member DMs Pixelup Bot ("add the design task [client] shared today"). The bot finds the message in the client channel, drafts the task (title, priority, deadline), resolves the correct client list, and quotes the client message it read so nothing gets misread. One tap to approve → task lands in ClickUp. Also available as a "…" message shortcut ("Add to ClickUp") on any message — same pipeline. The client sees nothing, ever. Intake rules:
   - **Reads are not capped.** `read_channel_messages` paginates over Slack cursors — `entire_channel: true` sweeps the whole channel, `since_date`/`until_date` bound a range, `limit` takes an explicit count (default 15, ceiling 5000 messages / 60k chars per read, and a read that leaves messages unread says so).
   - **Client references travel with the task.** Every image, file, and link the client attached (Slack file permalinks, link-preview URLs) goes into `reference_urls` and is rendered as a "References shared by the client" section on the ClickUp description. Non-URL entries are dropped in code so a reference can never be fabricated.
   - **Major deliverables only.** A new asset, screen, page, or brand element becomes a task. Small follow-ups that refer back to a design task the client already briefed (revisions, tweaks, feedback) are never separate tasks and never subtasks — they fold into the existing task via `propose_task_update`.
   - **Dates as stated, else end of week.** A date named in the client's message is used as-is; with no date, code defaults the due date to the Friday of the current week (`endOfWeek()` in `approvals/scaffold-rules.js`) so nothing lands undated. Today's date rides on the user message so relative dates resolve.
2. **Client onboarding** — Engagement guidelines doc sent to the bot in a DM. It reads scope, deliverables, and timeline, cross-checks the Fireflies kickoff transcript for anything agreed verbally, and proposes the full project structure (lists, tasks, priorities, due dates). Review → approve → project live in ClickUp.
3. **QA rounds** — Designers drop QA comments in a Slack thread. When the round wraps, tag Pixelup Bot in the thread. It dedupes comments, structures them (page, device, severity), and creates them as tasks in the QA list with links back in the thread — after approval.
4. **Tue/Fri client updates** — Scheduled run pulls the week's ClickUp activity and internal channel context per client, drafts the update in the agency voice, and posts it to an internal drafts channel with an approve button. Nothing reaches a client without human sign-off; a human sends the approved draft.
5. **Automation ideas** — Anyone on the team can float a process-automation idea to the bot ("add this to the automation ideas list"). It proposes a task in the Automation Ideas list (Operations space → Agents and Automations folder) via `propose_automation_idea`; approval is open to the requester or any lead, same as regular tasks — no lead gate, since this isn't client-facing work.

Later phases: sync prep agendas, Fireflies action-item follow-through, timeline watchdog (Phase 2); agency-wide scaffolds, capacity/retainer reports, SOP lookups (Phase 3).

## Team access

Everyone can query ("what's on my plate today", "status of X"); answers are scoped per person via the Slack→ClickUp user mapping in config. Only leads can trigger client-facing drafts or project scaffolding — enforced in listener code by Slack user ID. The agent has no delete access at all.

## Architecture

- **Approval pipeline**: agent tools only *propose* writes as structured JSON → stored in `approvals/store.js` → rendered as a Block Kit approval card → `approvals/executor.js` (deterministic code) executes against ClickUp only after an authorized user taps Approve.
- **Integrations via MCP servers** (decision 2026-07-13, replacing hand-rolled REST/GraphQL): the ClickUp and Fireflies MCP servers attach to the agent for **read-only** tool access — an explicit named allowlist in `agent/pixelup.js`, no wildcards, so their create/update/delete/send tools are never exposed to the agent. Approved writes run through `integrations/clickup-mcp.js`, where the executor connects as an MCP *client* and calls named create/update tools deterministically. MCP tool names/arg shapes must be verified against the live servers (`npm run auth:*` prints them).
- **MCP auth is OAuth** (decision 2026-07-13): `npm run auth:clickup` / `npm run auth:fireflies` run the one-time browser flow (PKCE + dynamic client registration via the MCP SDK); tokens persist in `data/mcp-auth/` (gitignored, mode 0600) and refresh automatically (`integrations/mcp-auth.js`). Static `*_MCP_TOKEN` env vars remain as overrides. Unauthorized servers don't attach; the executor fails with a pointer to the auth script.
- **Config**: `config/conventions.json` + `config/index.js` loader — priorities, naming, statuses, Slack↔ClickUp user mapping, roles, drafts channel, update schedule, non-client internal lists (`internal_lists`, e.g. Automation Ideas). Authoritative for everything that is NOT derivable from Slack or ClickUp, and loaded at startup.
- **Context resolution** (`config/resolver.js`): per-client IDs are NOT hand-maintained. Channel↔client comes from the naming convention (`{key}-pixelup` external, `{key}-internal` internal); a client's ClickUp list/QA list/folder come from their same-named ClickUp folder. Both are resolved on demand and memoized (channels 30 min, ClickUp targets 10 min). A `clients` entry in conventions.json is an **override** — any field it sets wins, any field left blank or `C_TODO_*` is discovered. Starting a project therefore needs no config edit: create the channels and the ClickUp folder as usual.
  - Writes still need a confirmed mapping: an unregistered client can be read, but `propose_*` refuses until a lead approves the one-tap `propose_client_registration` card, which writes the entry via `addClientToConventions` (no restart).
- **Agent**: `agent/pixelup.js` — `runPixelupAgent()`, system prompt + conventions summary built once at module load (stable for prompt caching), `maxTurns` capped.
- **Client-channel guard** (`canBotPostInChannel`): listener code drops any event that would make the bot respond in a client-facing channel. Decided by channel NAME, not by a config ID — a `{client}-pixelup` channel is client-facing whether or not anyone registered it — and **fail-closed**: if the channel cannot be identified, the bot stays silent. Direct conversations (`im`/`mpim`) are allowed on type alone, since `conversations.info` on a group DM needs a scope the app does not request.
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
- All non-derivable conventions (priorities, naming, user mapping, roles, schedules) live in
  config/conventions.json, loaded at startup. Per-client Slack/ClickUp IDs are resolved at
  runtime by config/resolver.js; config entries override it. Never re-add a code path that
  treats a missing or `C_TODO_*` ID as a real one — that is what silently disabled the
  client-channel guard.
- Keep the Bolt listener structure and thread-context session store from the template.
