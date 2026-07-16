# Pixelup Bot — Owner's Guide

Plain-language guide to understanding, debugging, cost-tuning, and customizing the bot.
Written against the code as of July 13, 2026.

---

## 1. The mental model (three sentences)

1. **The AI proposes. Humans approve. Plain code executes.**
   The agent has no tool that writes to ClickUp. When it wants to create or change
   something, it fills in structured JSON (a "proposal"), which becomes an
   Approve/Reject card in Slack. Only after a tap does ordinary, deterministic
   JavaScript perform the write.

2. **Reads are open; writes are a narrow pipe.**
   The agent can read ClickUp, Fireflies, and Slack through an explicit list of
   read-only tools. ALL writes funnel through one file (`approvals/executor.js`),
   which knows how to do five things and nothing else. No delete exists anywhere.

3. **One config file is the truth.**
   `config/conventions.json` holds every client→list mapping, user mapping, role,
   priority definition, and schedule. Add a client or teammate by editing JSON,
   never code.

---

## 2. Life of a message

What happens when someone DMs the bot "add the task Monumint shared today":

1. **Slack delivers the event** (Socket Mode). Bolt routes it to
   `listeners/events/message.js`.                                    [free]

2. **Guards run first — code, not AI.** Client channel? Dropped silently.
   Bot message without metadata? Dropped. A DM or engaged thread proceeds;
   bot reacts with eyes emoji and shows "Thinking…".                 [free]

3. **The agent runs.** `runPixelupAgent()` in `agent/pixelup.js` calls Claude
   with: system prompt + conventions summary (cached), your message, and the
   schemas of every allowlisted tool. Claude loops — think, call a tool, read
   the result — up to 16 turns.                                      [COSTS TOKENS]

4. **Tools execute.** To find the client's message it calls
   `read_channel_messages` (local Slack read). To check tasks it calls
   `clickup_filter_tasks` (ClickUp's MCP server). Tool calls are free, but
   their RESULT TEXT flows back into the context and costs input tokens on
   the next turn.

5. **The agent proposes.** It calls `propose_task` with title, priority, due
   date, and the verbatim client quote. `agent/tools/proposals.js` stores the
   JSON in `approvals/store.js` and posts the Block Kit card
   (`approvals/card-builder.js`) in your thread.

6. **A human taps Approve.** `listeners/actions/approval-buttons.js` re-checks
   the tapper's role against config.                                 [free]

7. **Deterministic execution.** `approvals/executor.js` resolves the real list
   ID from conventions, formats the task name, maps priority, and calls
   `integrations/clickup-mcp.js` — a plain MCP client that calls
   `clickup_create_task`. The card updates to "Approved & executed". [free]

**Paths that skip the agent entirely (zero tokens):**
- The "Add to ClickUp" message shortcut — proposal drafted in plain code.
- Approve/Reject buttons — always plain code.
- The Tue/Fri scheduler tick — a once-a-minute clock check; it only spends
  tokens when the configured day/time hits (one agent run per client).

---

## 3. Folder map

| Path                        | What it is                                          | Touch it when… |
|-----------------------------|-----------------------------------------------------|----------------|
| `config/conventions.json`   | Clients, users, roles, priorities, naming, schedule | Adding a client/teammate, changing schedule or naming |
| `agent/pixelup.js`          | System prompt, model, tool allowlist, turn cap      | Changing persona, model, or which tools the AI sees |
| `agent/tools/`              | Local tools: Slack reads + the 5 propose_* tools    | Adding a capability the agent can use |
| `approvals/`                | Proposal store, approval cards, the executor        | Adding a new type of write |
| `integrations/`             | MCP server config, OAuth token store, ClickUp write client | Auth problems, new external service |
| `listeners/`                | Slack entry points: events, buttons, shortcut, App Home | Changing guards, permissions, UI copy |
| `schedules/`                | Tue/Fri client-update clock                         | Changing when/what gets drafted automatically |
| `thread-context/`           | In-memory map: Slack thread → Claude session ID     | Rarely — it's how threads keep context |
| `scripts/authorize-mcp.js`  | One-time OAuth sign-in per MCP server               | Re-auth, or listing a server's real tools |
| `tests/`                    | 119 unit tests                                      | `npm test` after every change |
| `data/`                     | OAuth tokens (gitignored)                           | Delete a file to force re-auth |

---

## 4. Where the money goes

Every agent run sends:
- system prompt + conventions summary (~1.2k tokens) — **cached at ~10% price**
- schemas of all allowlisted tools (~2–4k tokens) — also cached
- the conversation so far (or a session resume)
- each tool result (full price)

You pay full price mainly for **tool results** and **Claude's own output**.

### Cost levers, biggest first

| Lever              | Where                                | Notes |
|--------------------|--------------------------------------|-------|
| Model choice       | `model:` in `agent/pixelup.js`       | Haiku ≈ 1/3 the price of Sonnet. Currently on Haiku for testing; production target is `claude-sonnet-5`. |
| Prompt caching     | Keep `SYSTEM_PROMPT` byte-stable     | It's built once at startup precisely so it caches. NEVER inject anything per-request (usernames, dates) into it — that breaks the cache and ~10x's prompt cost. |
| Allowlist size     | `CLICKUP_READ_TOOLS` etc. in pixelup.js | Every allowlisted tool's schema rides on every request. Trim unused tools. |
| Tool output size   | MCP servers + `slack-read.js`        | A huge task dump = huge input tokens next turn. Slack reads are capped (30 msgs, 20k chars for files). Watch MCP result sizes during testing. |
| Turn cap           | `MAX_TURNS = 16` in pixelup.js       | Ceiling on how far one request can spiral. |
| Zero-token paths   | Shortcut, approval buttons           | Prefer the shortcut for routine task intake. |
| Session resume     | `thread-context/`                    | Follow-ups resume a server-side session instead of resending history. |

**Rough math:** a typical Sonnet 5 request with warm cache ≈ $0.01–0.04; on Haiku a
few tenths of a cent. Scheduled updates = one run per client, twice a week. Check
the Anthropic console usage page after the first week of real use.

---

## 5. Debugging cookbook

Run with `slack run` (or `npm start`) from `claude-agent-sdk/` — Bolt logs at
DEBUG level to that terminal.

| Symptom                          | Likely cause → where to look |
|----------------------------------|------------------------------|
| Bot silent in a channel          | Channel is mapped as a client channel in conventions — silence is by design. Log says "Ignored app_mention in client channel". |
| Agent says it can't do X / tool denied | Tool name missing from the allowlist in `agent/pixelup.js`, or it's a write (by design). Names must match the live server exactly. |
| ClickUp reads fail / 401         | OAuth token expired (ClickUp issued no refresh token). Re-run `npm run auth:clickup`. |
| Approve button does nothing      | Check terminal: role denial (config), expired proposal (24h TTL — or the app restarted; the store is in-memory), or executor error shown on the card. |
| "Unknown client"                 | Agent used a client key not in conventions, or channel not mapped. |
| No response to a thread reply    | No stored session for that thread (restart cleared it). Mention the bot again. |
| Weird behavior/personality       | Read `BASE_SYSTEM_PROMPT` in `agent/pixelup.js` — prompt bugs look like personality bugs. |

### Poke at pieces in isolation

```sh
npm test && npm run lint && npm run check     # everything at once

# Is the config valid? (the app refuses to boot on a bad one)
node -e "import('./config/index.js').then(c => c.loadConventions())"

# What tools does a live MCP server actually expose?
npm run auth:clickup        # safe to re-run; prints the full tool list
```

---

## 6. Customization cookbook

| I want to…                        | Do this |
|-----------------------------------|---------|
| Add a client                      | Add an entry under `clients` in conventions.json (ClickUp folder/list/QA IDs, Slack channel ID). Restart. No code. |
| Add a teammate / promote to lead  | `users` section: Slack ID → ClickUp ID + role. Leads approve scaffolds and client drafts. |
| Change the personality            | Edit `BASE_SYSTEM_PROMPT` in `agent/pixelup.js`. Keep it static (cache!). Note: the BOUNDARIES prose is backed by code — editing it doesn't change enforcement. |
| Change the model                  | `model:` in `agent/pixelup.js`. |
| Let the agent read something new  | MCP server already has the read tool → add its exact name to the allowlist. Local capability → new tool factory in `agent/tools/`, register in pixelup.js, allowlist it. |
| Add a new kind of write           | Four small stops: schema in `agent/tools/proposals.js` → card text in `approvals/card-builder.js` → execution branch in `approvals/executor.js` → tests. Never let a tool write directly. |
| Change the update schedule        | `client_updates` in conventions: days/hour/minute/timezone; `enabled: true` once the drafts channel exists. |
| Change App Home / suggested prompts | `listeners/views/app-home-builder.js`; `SUGGESTED_PROMPTS` in `listeners/events/app-home-opened.js`. |

---

## 7. Don't break these (load-bearing)

1. **Never switch `permissionMode` to `bypassPermissions`.** The allowlist is the
   only thing standing between the agent and ClickUp's live `clickup_delete_task`
   tool. Bypass unlocks everything.
2. **Never add wildcards** (`mcp__clickup__*`) to the allowlist — same reason.
3. **Never post in client channels.** Enforced by guards in `message.js` /
   `app-mentioned.js` and a refusal in `proposals.js` — keep them when refactoring.
4. **Writes only via the executor.** If a tool ever calls ClickUp directly, the
   approval system is decorative.
5. **Permissions live in code + config, never in the prompt.** A prompt is a
   suggestion; a role check is a rule.

---

Related docs: `.claude/CLAUDE.md` (product spec + hard rules), `AGENTS.md`
(setup, commands, architecture reference).
