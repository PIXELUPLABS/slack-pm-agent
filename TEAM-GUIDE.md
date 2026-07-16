# Using the PIXELUP LABS Agent — a One-Pager for Designers

Pixelup Bot is our PM assistant in Slack. It handles the busywork between Slack, ClickUp, and Fireflies — logging tasks, structuring QA rounds, drafting client updates — so you don't have to leave your design flow to do admin.

**The one rule to remember: the bot never changes anything on its own.** Every ClickUp write comes back to you as an Approve / Reject card. Until someone taps Approve, nothing has happened. It also never posts in client channels and can't delete anything, anywhere.

## Where to find it

| Entry point | How |
|-------------|-----|
| **DM** | Open a DM with **PIXELUP LABS Agent** and just type. Follow-ups go in the same thread — it remembers the conversation. |
| **Message shortcut** | Hover any message → `…` menu → **Add to ClickUp**. Drafts a task from that message for approval. |
| **@mention** | Tag the bot in any *internal* thread (it ignores client channels by design). |
| **Home tab** | Buttons for common requests: New Task, Project Status, QA Round, Client Update Draft, Something Else. |

## What to ask it

**Check your work** — everyone can do this, answers are scoped to you:
> "What's on my plate today?" · "Status of the Monumint redesign?" · "What's due this week?"

**Log a client request** — say which client and which message:
> "Add the design task Monumint shared today in their channel."

The bot finds the client's message, drafts the task (title, priority, due date, correct list), and **quotes the client's exact words** on the card so you can verify it read the request right before approving. The `…` → **Add to ClickUp** shortcut does the same from any specific message.

**Wrap a QA round** — drop QA comments in the thread as usual, then tag the bot when the round is done. It dedupes and structures everything (page, device, severity) and proposes the tasks for the QA list.

**Client updates & project setup** — the bot drafts Tuesday/Friday client updates and can scaffold a whole project from an engagement doc, but only leads (Arjun, Daksh) can trigger and approve those. Drafts go to an internal channel; a human always sends the final message.

## Approvals

- **Task cards** — approved by whoever requested it, or any lead.
- **Project scaffolds & client update drafts** — leads only.
- Card looks wrong? **Reject it and rephrase your request** — nothing was written, so there's nothing to undo.

## Tips

- **Be specific.** "Add the banner task Monumint asked for today, due Friday, high priority" beats "add that task."
- **Stay in the thread.** The bot keeps context per thread — follow-ups like "make it urgent instead" just work.
- **Use plain Slackbot for pure Slack questions** (thread summaries, meeting prep). It's free. Pixelup Bot is for anything touching ClickUp or Fireflies.
- **The client never sees the bot.** It reads client channels but will never post in them — no need to worry about it replying somewhere embarrassing.

Stuck or seeing something weird? Ping Arjun or Daksh.
