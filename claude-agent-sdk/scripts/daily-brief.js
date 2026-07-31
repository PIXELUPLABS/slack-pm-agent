import 'dotenv/config';
import { WebClient } from '@slack/web-api';

import { loadConventions } from '../config/index.js';
import { zonedParts } from '../schedules/client-updates.js';
import {
  listWorkspaceChannels,
  lookbackHoursFor,
  runDailyBrief,
  selectInternalChannels,
  windowStart,
} from '../schedules/daily-brief.js';

/**
 * Run the daily founder brief by hand, before it is ever scheduled.
 *
 * Dry by default: it assembles the real brief and prints it, sending nothing.
 *
 *   node scripts/daily-brief.js --coverage     # which internal channels can I read? (free, no model call)
 *   node scripts/daily-brief.js                # build the brief, print it, send nothing
 *   node scripts/daily-brief.js --dm           # ...and DM it to daily_brief.recipient_slack_id
 *   node scripts/daily-brief.js --dm U09RKSU0QSX
 *
 * Flags:
 *   --coverage      Channel selection and bot membership only. No history reads, no model call, no cost.
 *   --hours N       Look back N hours instead of the configured window.
 *   --since <ts>    Explicit window start (YYYY-MM-DD or full ISO timestamp).
 *   --digest        Also print the raw digest handed to the model.
 *   --dm [user-id]  Actually send the DM. Bare --dm uses daily_brief.recipient_slack_id.
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

const conventions = loadConventions();
const cfg = conventions.daily_brief || {};
const client = new WebClient(token);

const recipientId = flagValue('--dm') || cfg.recipient_slack_id || '';
if (wantsDm && !recipientId) {
  console.error('--dm needs a recipient: pass one (--dm U123…) or set daily_brief.recipient_slack_id in conventions.');
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
const hours = hoursArg ? Number(hoursArg) : lookbackHoursFor(zonedParts(now, timezone).weekday, cfg);
if (hoursArg && !Number.isFinite(hours)) {
  console.error(`--hours must be a number, got "${hoursArg}".`);
  process.exit(1);
}
const since = sinceArg || windowStart(now, hours);

console.log(
  `\n${label('Daily brief')} ${dim(`— window ${since} → now${wantsDm ? '' : '  (dry run, nothing will be sent)'}`)}\n`,
);

const result = await runDailyBrief({
  client,
  conventions,
  recipientId,
  since,
  deliver: wantsDm,
  logger: { info: (/** @type {string} */ m) => console.log(dim(`  ${m}`)), error: console.error },
});

console.log(`${label('Channels swept')}`);
for (const c of result.active) {
  const threads = c.threadsExpanded ? `, ${c.threadsExpanded} thread(s) expanded` : '';
  console.log(`  ✓ ${c.name} ${dim(`${c.messageCount} message(s)${threads}`)}`);
}
if (result.quiet.length) console.log(`  ${dim(`quiet: ${result.quiet.join(', ')}`)}`);
if (result.unreadable.length) {
  console.log(`\n${label('Unreadable')}`);
  for (const c of result.unreadable) console.log(`  ✗ ${c.name} ${dim(c.error)}`);
}

if (showDigest) {
  console.log(`\n${label('Digest handed to the model')}\n${dim('─'.repeat(60))}`);
  console.log(result.digest || '(empty)');
}

console.log(`\n${label('Brief')}\n${dim('─'.repeat(60))}`);
console.log(result.brief);
console.log(dim('─'.repeat(60)));

if (result.deliveredTo) {
  console.log(`\n✓ DM'd to ${recipientId} ${dim(`(conversation ${result.deliveredTo})`)}\n`);
} else {
  console.log(
    `\n${dim(`Dry run — nothing sent. Re-run with --dm${cfg.recipient_slack_id ? '' : ' U…'} to deliver it.`)}\n`,
  );
}
