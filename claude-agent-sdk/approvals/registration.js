/**
 * Client registration lookup — the deterministic legwork behind the
 * "register client" flow. Given a client name, it finds the client's folder
 * and lists in ClickUp and resolves the Slack channels by the agency's naming
 * convention ({key}-pixelup external, {key}-internal internal), producing the
 * exact conventions.json entry the approval card will show.
 *
 * Slack channels are created long before an engagement starts, so this flow
 * only ever RESOLVES channels — it never creates anything in Slack.
 */

/**
 * Derive the conventions client key from a display name.
 * "Marker" → "marker", "Henry Labs" → "henry-labs".
 * @param {string} name
 * @returns {string}
 */
export function deriveClientKey(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Find the client's folder (and its lists) in the ClickUp hierarchy.
 * @param {any} hierarchyRoot - From clickup-mcp getHierarchy().
 * @param {string} clientName
 * @returns {{ folder: any, lists: any[] } | null}
 */
export function findClientFolder(hierarchyRoot, clientName) {
  const needle = clientName.trim().toLowerCase();
  for (const space of hierarchyRoot?.children || []) {
    for (const child of space.children || []) {
      if (child.type === 'folder' && child.name.trim().toLowerCase() === needle) {
        return { folder: child, lists: (child.children || []).filter((/** @type {any} */ c) => c.type === 'list') };
      }
    }
  }
  return null;
}

/**
 * Split a folder's lists into the main engagement list and the QA list.
 * @param {any[]} lists
 * @returns {{ mainList: any | null, qaList: any | null }}
 */
export function pickLists(lists) {
  const qaList = lists.find((l) => /\bqa\b/i.test(l.name)) || null;
  const mainList = lists.find((l) => l !== qaList) || null;
  return { mainList, qaList };
}

/**
 * Resolve the client's Slack channels by naming convention. Only channels the
 * bot can see (public, or private ones it was invited to) are found.
 * @param {import('@slack/web-api').WebClient} slackClient
 * @param {string} clientKey
 * @returns {Promise<{ externalChannelId: string, internalChannelId: string }>}
 */
export async function findClientChannels(slackClient, clientKey) {
  const wanted = { [`${clientKey}-pixelup`]: 'external', [`${clientKey}-internal`]: 'internal' };
  /** @type {{ externalChannelId: string, internalChannelId: string }} */
  const found = { externalChannelId: '', internalChannelId: '' };

  let cursor;
  do {
    const result = await slackClient.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const channel of result.channels || []) {
      const role = wanted[/** @type {string} */ (channel.name)];
      if (role === 'external') found.externalChannelId = /** @type {string} */ (channel.id);
      if (role === 'internal') found.internalChannelId = /** @type {string} */ (channel.id);
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && (!found.externalChannelId || !found.internalChannelId));

  return found;
}

/**
 * Build the full registration: the conventions entry plus human-readable
 * notes about anything that could not be resolved.
 * @param {{ clientName: string, slackClient: import('@slack/web-api').WebClient, clickup: { getHierarchy: () => Promise<any> } }} deps
 * @returns {Promise<{ clientKey: string, entry: any, notes: string[] }>}
 */
export async function buildRegistration({ clientName, slackClient, clickup }) {
  const clientKey = deriveClientKey(clientName);
  if (!clientKey) throw new Error(`Could not derive a client key from "${clientName}".`);

  const root = await clickup.getHierarchy();
  const match = findClientFolder(root, clientName);
  if (!match) {
    throw new Error(
      `No ClickUp folder named "${clientName}" found. Create the client folder (usually in the Delivery space) first, then register again.`,
    );
  }

  const { mainList, qaList } = pickLists(match.lists);
  if (!mainList) {
    throw new Error(
      `The "${match.folder.name}" folder has no lists yet. Create the engagement list (or scaffold after registering with a list), then register again.`,
    );
  }

  const channels = await findClientChannels(slackClient, clientKey);

  /** @type {string[]} */
  const notes = [];
  if (!qaList) notes.push('No QA list found — duplicate "QA Board Demo" into the folder when QA starts.');
  if (!channels.externalChannelId)
    notes.push(`No #${clientKey}-pixelup channel visible — invite the bot to it, then update the config.`);
  if (!channels.internalChannelId) notes.push(`No #${clientKey}-internal channel visible.`);

  return {
    clientKey,
    entry: {
      display_name: clientName.trim(),
      channel_id: channels.externalChannelId,
      internal_channel_id: channels.internalChannelId,
      list_id: String(mainList.id),
      qa_list_id: qaList ? String(qaList.id) : '',
      folder_id: String(match.folder.id),
    },
    notes,
  };
}
