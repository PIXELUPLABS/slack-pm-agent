import 'dotenv/config';
import { WebClient } from '@slack/web-api';

import { loadConventions } from '../config/index.js';
import { zonedParts } from '../schedules/client-updates.js';
import {
  listWorkspaceChannels,
  runDailyBrief,
  selectInternalChannels,
  windowHoursFor,
  windowStart,
} from '../schedules/daily-brief.js';

/**
 * Run the founder brief by hand, before it is ever scheduled.
 *
 * Dry by default: it assembles the real brief and prints it, sending nothing.
 *
 *   node scripts/daily-brief.js --coverage     # which internal channels can I read? (free, no model call)
 *   node scripts/daily-brief.js                # build the brief, print it, send nothing
 *   node scripts/daily-brief.js --weekly       # build Monday's weekly review, any day of the week
 *   node scripts/daily-brief.js --dm           # ...and DM it to daily_brief.recipient_slack_id
 *   node scripts/daily-brief.js --dm U09RKSU0QSX
 *
 * Flags:
 *   --coverage      Channel selection and bot membership only. No history reads, no model call, no cost.
 *   --weekly        Force the weekly review (map-reduce over 7 days). Costs one model
 *                   call per active channel plus one, so it is the expensive preview.
 *   --daily         Force the daily brief, even on the weekly review day.
 *   --hours N       Look back N hours instead of the mode's window.
 *   --since <ts>    Explicit window start (YYYY-MM-DD or full ISO timestamp).
 *   --digest        Also print the raw digest handed to the model.
 *   --dm [user-id]  Actually send the DM. Bare --dm uses daily_brief.recipient_slack_id.
 *                   Passing an id changes only WHO RECEIVES this copy — "Needs you"
 *                   stays anchored on daily_brief.recipient_slack_id, so previewing
 *                   someone else's brief cannot silently make it yours.
 *   --as <user-id>  Change who the brief is ABOUT (overrides daily_brief.recipient_slack_id).
 *
 * Requires SLACK_BOT_TOKEN (app settings → OAuth & Permissions → Bot User OAuth
 * Token) and, for anything but --coverage, ANTHROPIC_API_KEY. The bot only sees
 * private channels it has been invited to.
 */

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('SLACK_BOT_TOKEN is not set. Copy the Bot User OAuth Token from app settings → OAuth & Permissions.');
  process.exit(1);
}

const argv = process.argv.slice(2);
/** @param {string} flag */
const flagValue = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
};

const coverageOnly = argv.includes('--coverage');
const showDigest = argv.includes('--digest');
const wantsDm = argv.includes('--dm');
const hoursArg = flagValue('--hours');
const sinceArg = flagValue('--since');
if (argv.includes('--weekly') && argv.includes('--daily')) {
  console.error('Pass --weekly or --daily, not both.');
  process.exit(1);
}
/** @type {'weekly' | 'daily' | undefined} */
const modeArg = argv.includes('--weekly') ? 'weekly' : argv.includes('--daily') ? 'daily' : undefined;

const conventions = loadConventions();
const cfg = conventions.daily_brief || {};
const client = new WebClient(token);

// The brief is always ABOUT daily_brief.recipient_slack_id — that is what anchors
// "Needs you". --dm only changes WHERE this copy lands, so previewing someone
// else's brief cannot silently re-anchor the section on the previewer.
const subjectId = flagValue('--as') || cfg.recipient_slack_id || '';
const deliverTo = flagValue('--dm') || subjectId;
if (wantsDm && !deliverTo) {
  console.error('--dm needs a target: pass one (--dm U123…) or set daily_brief.recipient_slack_id in conventions.');
  process.exit(1);
}
if (!subjectId) {
  console.error('No subject for the brief: set daily_brief.recipient_slack_id, or pass --as U123….');
  process.exit(1);
}

const label = (/** @type {string} */ s) => `\x1b[1m${s}\x1b[0m`;
const dim = (/** @type {string} */ s) => `\x1b[2m${s}\x1b[0m`;

if (coverageOnly) {
  const workspace = await listWorkspaceChannels(client);
  const { channels, excluded, missing, skipped } = selectInternalChannels(workspace, conventions);
  const readable = channels.filter((c) => c.isMember);
  const notJoined = channels.filter((c) => !c.isMember);

  console.log(`\n${label('Internal channel coverage')}  ${dim(`(${workspace.size} channels visible to the bot)`)}\n`);
  console.log(`${label(`Readable (${readable.length})`)} — these are what the brief will sweep:`);
  for (const c of readable)
    console.log(`  ✓ #${c.name}${c.clientKey ? dim(`  → ${c.clientKey}`) : ''} ${dim(c.source)}`);

  if (notJoined.length) {
    console.log(`\n${label(`Not joined (${notJoined.length})`)} — invite the bot to include these:`);
    for (const c of notJoined) console.log(`  ✗ #${c.name} ${dim(c.source)}`);
    console.log(dim('\n  /invite @PIXELUP LABS Agent   in each of the above'));
  }
  if (skipped.length) {
    console.log(
      `\n${label(`Skipped (${skipped.length})`)} — look internal but aren't a registered client; add the client to conventions, or the channel to daily_brief.internal_channels:`,
    );
    for (const c of skipped) console.log(`  – #${c.name}`);
  }
  if (excluded.length) {
    console.log(`\n${label(`Excluded (${excluded.length})`)} — config points at these, but they are client-facing:`);
    for (const c of excluded) console.log(`  – #${c.name} ${dim(c.reason)}`);
  }
  if (missing.length) {
    console.log(`\n${label(`Configured but invisible (${missing.length})`)}:`);
    for (const m of missing) console.log(`  ? ${m.id} ${dim(m.reason)}`);
  }
  console.log('');
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — needed to write the brief. Use --coverage to check channels for free.');
  process.exit(1);
}

const now = new Date();
const timezone = cfg.timezone || 'Asia/Kolkata';
const window = windowHoursFor(zonedParts(now, timezone).weekday, cfg, modeArg);
const hours = hoursArg ? Number(hoursArg) : window.lookbackHours;
if (hoursArg && !Number.isFinite(hours)) {
  console.error(`--hours must be a number, got "${hoursArg}".`);
  process.exit(1);
}
const since = sinceArg || windowStart(now, hours);

const subjectName = conventions.users?.[subjectId]?.name || subjectId;
const targetName = conventions.users?.[deliverTo]?.name || deliverTo;
const modeLabel = window.mode === 'weekly' ? 'Weekly review' : 'Daily brief';
const forced = modeArg ? dim('  (forced)') : '';
console.log(`\n${label(modeLabel)}${forced} ${dim(`— window ${since} → now`)}`);
const anchorNote = window.mode === 'weekly' ? 'weekly reviews have no "Needs you"' : '"Needs you" is anchored here';
console.log(dim(`  about: ${subjectName} (${subjectId})  ·  ${anchorNote}`));
const previewNote = wantsDm && deliverTo !== subjectId ? '   ← PREVIEW: different person than the subject' : '';
const target = wantsDm ? `${targetName} (${deliverTo})` : 'nobody — dry run';
console.log(`${dim(`  sends to: ${target}${previewNote}`)}\n`);

const result = await runDailyBrief({
  client,
  conventions,
  recipientId: subjectId,
  deliverTo,
  since,
  deliver: wantsDm,
  mode: modeArg,
  logger: { info: (/** @type {string} */ m) => console.log(dim(`  ${m}`)), error: console.error },
});

console.log(`${label('Channels swept')}`);
for (const c of result.active) {
  const threads = c.threadsExpanded ? `, ${c.threadsExpanded} thread(s) expanded` : '';
  const days = result.mode === 'weekly' && c.activeDays ? `, ${c.activeDays} active day(s)` : '';
  console.log(`  ✓ ${c.name} ${dim(`${c.messageCount} message(s)${threads}${days}`)}`);
}
if (result.quiet.length) console.log(`  ${dim(`quiet: ${result.quiet.join(', ')}`)}`);
if (result.unreadable.length) {
  console.log(`\n${label('Unreadable')}`);
  for (const c of result.unreadable) console.log(`  ✗ ${c.name} ${dim(c.error)}`);
}

// The code-derived basis for "Needs you" — auditable without reading the prompt.
// Weekly reviews have no "Needs you" (a week-old mention is a dead ask), so
// there is nothing to audit in that mode.
if (result.mode !== 'weekly') {
  console.log(`\n${label(`Tagged ${result.recipientName} directly`)} ${dim('(the only source for "Needs you")')}`);
  if (result.mentions.length) {
    for (const m of result.mentions) {
      const state = m.answered ? dim('answered in-thread → excluded') : '\x1b[33mopen\x1b[0m';
      console.log(`  • #${m.channel} ${m.author} — ${state}`);
      console.log(`    ${dim(m.text.slice(0, 120))}`);
    }
  } else {
    console.log(dim('  nothing in the window tagged them'));
  }
}

if (showDigest) {
  const what =
    result.mode === 'weekly' ? 'Per-channel summaries handed to the reduce call' : 'Digest handed to the model';
  console.log(`\n${label(what)}\n${dim('─'.repeat(60))}`);
  console.log(result.digest || '(empty)');
}

console.log(`\n${label(modeLabel)}\n${dim('─'.repeat(60))}`);
console.log(result.brief);
console.log(dim('─'.repeat(60)));

if (result.deliveredTo) {
  console.log(`\n✓ DM'd to ${targetName} (${deliverTo}) ${dim(`(conversation ${result.deliveredTo})`)}\n`);
} else {
  console.log(
    `\n${dim(`Dry run — nothing sent. Re-run with --dm${cfg.recipient_slack_id ? '' : ' U…'} to deliver it.`)}\n`,
  );
}
