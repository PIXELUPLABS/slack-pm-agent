# AGENTS.md - pixelup-slack-pm-agent

## Project Overview

**PIXELUP LABS Agent** (internally "Pixelup Bot") — an AI project-management agent for the Pixelup Labs design agency Slack, built with [Bolt for JavaScript](https://github.com/slackapi/bolt-js) and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). It handles PM busywork between Slack, ClickUp, and Fireflies: client task intake, project scaffolds from engagement docs, QA round structuring, and Tue/Fri client update drafts.

The application lives in `claude-agent-sdk/`. See `claude-agent-sdk/AGENTS.md` for setup, commands, folder structure, and architecture details, and `claude-agent-sdk/.claude/CLAUDE.md` for the product spec and hard rules.

## Core Principles

- **The AI proposes. Humans approve. Plain code executes.** Agent tools only produce structured JSON proposals; `approvals/executor.js` performs writes deterministically after an authorized user taps Approve.
- **Reads are open; writes are a narrow pipe.** ClickUp and Fireflies MCP servers attach read-only via an explicit tool allowlist. No delete capability exists anywhere.
- **The bot never posts in client channels.** Listener code drops those events before the agent runs, and every Slack write path re-checks the channel by name, fail-closed. It does post in *internal* channels — approved reminders and canvas updates.
- **`config/conventions.json` is the single source of truth** for client→list mappings, user mappings, roles, priorities, and schedules.
- **Permissions live in listener code** (Slack user ID checks against config roles), never in the system prompt.

## Code Style

Uses [Biome](https://biomejs.dev/) for linting and formatting:

- 2-space indentation
- 120-character line width
- Single quotes
- LF line endings
- ES modules (`"type": "module"` in `package.json`)
- Kebab-case filenames
- Organized imports (via Biome assist)

## Checks

Run from `claude-agent-sdk/`:

- `npm run lint` — Biome lint and format check
- `npm run check` — `tsc --checkJs` type check on JavaScript files
- `npm test` — Node.js built-in test runner (no network access in tests)
