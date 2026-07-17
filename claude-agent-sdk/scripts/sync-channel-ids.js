import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebClient } from '@slack/web-api';

/**
 * One-time/occasional sync of Slack channel IDs into config/conventions.json.
 *
 * Finds each client's channels by the naming convention ({key}-pixelup for the
 * external client channel, {key}-internal for the internal one) and fills in
 * IDs that are missing or still placeholders (e.g. C_TODO_MONUMINT). Real IDs
 * already in the config are never overwritten.
 *
 * Dry-run by default — pass --write to save. Requires SLACK_BOT_TOKEN:
 *
 *   SLACK_BOT_TOKEN=xoxb-… node scripts/sync-channel-ids.js --write
 *
 * (Get the token from your app's settings → OAuth & Permissions → Bot User
 * OAuth Token. `slack run` injects it for the app itself, but not for this
 * script. Private channels are only visible if the bot has been invited.)
 */

const CONVENTIONS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'conventions.json');

/** @param {string | undefined} value */
const looksLikeChannelId = (value) => /^[CDG][A-Z0-9]{5,}$/.test(value || '');

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('SLACK_BOT_TOKEN is not set. Copy the Bot User OAuth Token from app settings → OAuth & Permissions.');
  process.exit(1);
}
const write = process.argv.includes('--write');

const client = new WebClient(token);
/** @type {Map<string, { id: string, isPrivate: boolean, isMember: boolean }>} */
const channelsByName = new Map();
let cursor;
do {
  const res = await client.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
    cursor,
  });
  for (const c of res.channels || []) {
    if (c.name && c.id) channelsByName.set(c.name, { id: c.id, isPrivate: !!c.is_private, isMember: !!c.is_member });
  }
  cursor = res.response_metadata?.next_cursor || undefined;
} while (cursor);

const conventions = JSON.parse(fs.readFileSync(CONVENTIONS_PATH, 'utf8'));
let changes = 0;
for (const [key, entry] of Object.entries(conventions.clients)) {
  for (const [field, suffix] of [
    ['channel_id', 'pixelup'],
    ['internal_channel_id', 'internal'],
  ]) {
    const current = entry[field];
    const name = `${key}-${suffix}`;
    const found = channelsByName.get(name);
    if (looksLikeChannelId(current)) {
      continue; // never overwrite a real ID
    }
    if (!found) {
      if (field === 'channel_id') console.log(`?  ${key}: no #${name} channel visible to the bot`);
      continue;
    }
    console.log(
      `✔  ${key}: ${field} ${current || '(unset)'} → ${found.id} (#${name}${found.isMember ? '' : ', bot NOT a member'})`,
    );
    entry[field] = found.id;
    changes += 1;
  }
}

if (changes === 0) {
  console.log('Nothing to update — all configured IDs are real or no matching channels were found.');
} else if (write) {
  fs.writeFileSync(CONVENTIONS_PATH, `${JSON.stringify(conventions, null, 2)}\n`);
  console.log(`\n${changes} channel ID(s) written to config/conventions.json — restart the bot to pick them up.`);
} else {
  console.log(`\nDry run: ${changes} channel ID(s) would be updated. Re-run with --write to save.`);
}
