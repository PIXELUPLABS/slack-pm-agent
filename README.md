# PIXELUP LABS Agent

An AI project-management agent that lives in the Pixelup Labs Slack. It handles the PM busywork between Slack, ClickUp, and Fireflies — task intake, project scaffolds, QA rounds, and client update drafts — so designers stay on design.

Built with [Bolt for JavaScript](https://tools.slack.dev/bolt-js/) and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).

## What it does

* **Client task intake** — DM the bot ("add the design task Monumint shared today") or use the _Add to ClickUp_ message shortcut. It finds the client message, drafts the task with the right list, priority, and due date, and quotes the source message so nothing gets misread. One tap to approve → task lands in ClickUp.
* **Client onboarding** — Send it an engagement guidelines doc. It cross-checks the Fireflies kickoff transcript and proposes the full project structure (lists, tasks, priorities, due dates) for review and approval.
* **QA rounds** — Tag it in a QA thread when the round wraps. It dedupes and structures the comments (page, device, severity) and creates them as tasks in the QA list after approval.
* **Tue/Fri client updates** — A scheduled run pulls the week's ClickUp activity and internal channel context per client, drafts the update in the agency voice, and posts it to an internal drafts channel for sign-off. A human sends every approved draft.

## How it's kept safe

The AI proposes; humans approve; plain code executes.

* Every ClickUp write is proposed as structured JSON, rendered as an Approve/Reject card in Slack, and executed by deterministic code only after an authorized tap.
* The bot never posts in client channels — listener code drops those events before the agent ever runs.
* No delete capability exists anywhere.
* Role checks (who can trigger client-facing drafts or scaffolding) are enforced in listener code by Slack user ID, never via the prompt.

## Getting started

**Using the bot?** Read the [Team Guide](./TEAM-GUIDE.md) — a one-pager for designers on how to work with the agent in Slack.

The app lives in [`claude-agent-sdk/`](./claude-agent-sdk/). See its [README](./claude-agent-sdk/README.md) for setup, [AGENTS.md](./claude-agent-sdk/AGENTS.md) for architecture and conventions, and [OWNERS-GUIDE.md](./claude-agent-sdk/OWNERS-GUIDE.md) for the plain-language guide to debugging, cost-tuning, and customizing the bot.

```sh
cd claude-agent-sdk
cp .env.sample .env   # Fill in ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN
npm install
npm run auth:clickup     # One-time OAuth sign-in for the ClickUp MCP server
npm run auth:fireflies   # One-time OAuth sign-in for the Fireflies MCP server
npm start
```

## License

MIT — see [LICENSE](./LICENSE). Originally bootstrapped from Slack's [bolt-js-support-agent](https://github.com/slack-samples/bolt-js-support-agent) sample.
