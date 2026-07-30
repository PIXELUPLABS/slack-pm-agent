/**
 * Runtime context resolution — the bot works out which client a channel belongs
 * to, and which ClickUp lists that client owns, by LOOKING instead of by
 * reading hand-maintained IDs out of conventions.json.
 *
 * Why: every ID a person used to type here is derivable. The agency names
 * channels `{key}-pixelup` (external, client present) and `{key}-internal`
 * (internal), and each client owns a same-named ClickUp folder holding the
 * engagement list and a QA list. Storing those IDs makes conventions.json a
 * cache of facts that live elsewhere — and a hand-edited cache goes stale
 * silently. Here they are resolved on demand and memoized with a TTL.
 *
 * conventions.json keeps what is NOT derivable (users, roles, priorities,
 * naming, voice, schedules) and stays authoritative as an OVERRIDE for any
 * client that breaks convention.
 */

/** External client channel suffix — the client is in the room. */
const EXTERNAL_SUFFIX = '-pixelup';
/** Internal per-client channel suffix — team only. */
const INTERNAL_SUFFIX = '-internal';

/** Channel names change rarely; ID→name is cheap to hold. */
const CHANNEL_TTL_MS = 30 * 60 * 1000;
/** Folders/lists move more often than channels get renamed. */
const TARGETS_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, { value: any, at: number }>} */
const channelCache = new Map();
/** @type {Map<string, { value: any, at: number }>} */
const targetsCache = new Map();

/** Reset every memo (tests, and after a config write). @returns {void} */
export function resetResolverCache() {
  channelCache.clear();
  targetsCache.clear();
}

/**
 * @param {Map<string, { value: any, at: number }>} cache
 * @param {string} key
 * @param {number} ttl
 * @returns {any | undefined}
 */
function cached(cache, key, ttl) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

/**
 * Placeholder IDs (`C_TODO_ACME`) and empty strings mean "never filled in".
 * They must never be treated as real IDs — a placeholder compared against a
 * live channel ID silently matches nothing, which is how the client-channel
 * guard came to be unenforced.
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isPlaceholderId(value) {
  return !value || /^C_TODO/i.test(value) || /^TODO/i.test(value);
}

/**
 * Classify a channel from its NAME alone — no config, no API call, no failure
 * mode. This is the primary signal for the "never speak in front of a client"
 * rule precisely because it cannot go stale or error.
 * @param {string | undefined} name
 * @returns {{ kind: 'client-external' | 'client-internal' | 'other', clientKey: string | null }}
 */
export function classifyChannelName(name) {
  const clean = (name || '').trim().toLowerCase().replace(/^#/, '');
  if (clean.endsWith(EXTERNAL_SUFFIX)) {
    return { kind: 'client-external', clientKey: clean.slice(0, -EXTERNAL_SUFFIX.length) || null };
  }
  if (clean.endsWith(INTERNAL_SUFFIX)) {
    return { kind: 'client-internal', clientKey: clean.slice(0, -INTERNAL_SUFFIX.length) || null };
  }
  return { kind: 'other', clientKey: null };
}

/**
 * Channel name for an ID, memoized. Returns null when Slack can't tell us.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @returns {Promise<string | null>}
 */
export async function resolveChannelName(client, channelId) {
  if (!channelId) return null;
  const hit = cached(channelCache, channelId, CHANNEL_TTL_MS);
  if (hit !== undefined) return hit;
  try {
    const res = await client.conversations.info({ channel: channelId });
    const name = /** @type {any} */ (res)?.channel?.name || null;
    channelCache.set(channelId, { value: name, at: Date.now() });
    return name;
  } catch {
    // Don't memoize failures — a transient error shouldn't pin this channel
    // into the wrong bucket for the next 30 minutes.
    return null;
  }
}

/**
 * Full channel context: what kind of channel this is and whose it is. Config
 * wins when it explicitly maps the ID (that's the override for clients whose
 * channels don't follow the convention); otherwise the name decides.
 * @param {{ client: import('@slack/web-api').WebClient, conventions: import('./index.js').Conventions, channelId: string }} args
 * @returns {Promise<{ kind: 'client-external' | 'client-internal' | 'other', clientKey: string | null, resolved: boolean }>}
 */
export async function resolveChannelContext({ client, conventions, channelId }) {
  for (const [key, c] of Object.entries(conventions.clients)) {
    if (!isPlaceholderId(c.channel_id) && c.channel_id === channelId) {
      return { kind: 'client-external', clientKey: key, resolved: true };
    }
    if (!isPlaceholderId(c.internal_channel_id) && c.internal_channel_id === channelId) {
      return { kind: 'client-internal', clientKey: key, resolved: true };
    }
  }
  const name = await resolveChannelName(client, channelId);
  if (name === null) return { kind: 'other', clientKey: null, resolved: false };
  return { ...classifyChannelName(name), resolved: true };
}

/**
 * May the bot post here? The hard rule is that a client must never see it, so
 * this answers NO for any client-facing channel — and also for a channel it
 * could not identify. Silence on a failed lookup is recoverable; a message in
 * front of a client is not.
 *
 * Direct conversations (`im`, `mpim`) are allowed on type alone: someone opened
 * or added the bot to them deliberately, and `conversations.info` on a group DM
 * needs a scope the app doesn't request — so a lookup there would fail and
 * wrongly silence the bot.
 * @param {{ client: import('@slack/web-api').WebClient, conventions: import('./index.js').Conventions, channelId: string, channelType?: string }} args
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
export async function canBotPostInChannel({ client, conventions, channelId, channelType }) {
  if (!channelId) return { allowed: false, reason: 'no channel id' };
  if (channelType === 'im' || channelType === 'mpim') {
    return { allowed: true, reason: `direct conversation (${channelType})` };
  }
  // A `D…` ID is always an IM — there is no such thing as a client-facing DM,
  // and `conversations.info` on one returns no name, which would otherwise trip
  // the fail-closed branch below. This makes the carve-out work even for callers
  // that have no channelType to pass (e.g. the proposal tools).
  if (/^D[A-Z0-9]/.test(channelId)) {
    return { allowed: true, reason: 'direct message' };
  }
  const ctx = await resolveChannelContext({ client, conventions, channelId });
  if (!ctx.resolved) {
    return { allowed: false, reason: `could not identify channel ${channelId} — staying silent (fail-closed)` };
  }
  if (ctx.kind === 'client-external') {
    return {
      allowed: false,
      reason: `${channelId} is a client-facing channel (${ctx.clientKey}) — the bot stays silent`,
    };
  }
  return { allowed: true, reason: 'internal channel' };
}

/**
 * ClickUp targets for a client: the engagement list, the QA list, the folder.
 * Config overrides win per-field (so a hand-set list_id keeps working); the
 * rest come from the live ClickUp hierarchy, matched on folder name.
 * @param {{ clientKey: string, conventions: import('./index.js').Conventions, clickup?: { getHierarchy: () => Promise<any> } | null }} args
 * @returns {Promise<{ listId: string, qaListId: string, folderId: string, displayName: string, source: 'config' | 'clickup' | 'mixed' } | null>}
 */
export async function resolveClientTargets({ clientKey, conventions, clickup }) {
  const entry = conventions.clients[clientKey];
  const fromConfig = {
    listId: entry && !isPlaceholderId(entry.list_id) ? entry.list_id : '',
    qaListId: entry && !isPlaceholderId(entry.qa_list_id) ? entry.qa_list_id : '',
    folderId: entry && !isPlaceholderId(entry.folder_id) ? entry.folder_id : '',
  };
  const displayName = entry?.display_name || clientKey;

  // Fully specified in config — no lookup needed.
  if (fromConfig.listId && fromConfig.qaListId && fromConfig.folderId) {
    return { ...fromConfig, displayName, source: 'config' };
  }
  if (!clickup) {
    return fromConfig.listId ? { ...fromConfig, displayName, source: 'config' } : null;
  }

  const memo = cached(targetsCache, clientKey, TARGETS_TTL_MS);
  const discovered = memo ?? (await discoverClientTargets({ clientKey, displayName, clickup }));
  if (!memo && discovered) targetsCache.set(clientKey, { value: discovered, at: Date.now() });
  if (!discovered) return fromConfig.listId ? { ...fromConfig, displayName, source: 'config' } : null;

  const merged = {
    listId: fromConfig.listId || discovered.listId,
    qaListId: fromConfig.qaListId || discovered.qaListId,
    folderId: fromConfig.folderId || discovered.folderId,
  };
  if (!merged.listId) return null;
  const usedConfig = Boolean(fromConfig.listId || fromConfig.qaListId || fromConfig.folderId);
  return { ...merged, displayName, source: usedConfig ? 'mixed' : 'clickup' };
}

/**
 * Locate a client's folder in the live ClickUp hierarchy and pick its lists.
 * Matches the folder name against the display name and the key, so both
 * "Henry Labs" and "henry-labs" find the same folder.
 * @param {{ clientKey: string, displayName: string, clickup: { getHierarchy: () => Promise<any> } }} args
 * @returns {Promise<{ listId: string, qaListId: string, folderId: string } | null>}
 */
async function discoverClientTargets({ clientKey, displayName, clickup }) {
  /** @param {string} s */
  const norm = (s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  const wanted = new Set([norm(displayName), norm(clientKey)]);

  let root;
  try {
    root = await clickup.getHierarchy();
  } catch {
    return null;
  }

  for (const space of root?.children || []) {
    for (const child of space.children || []) {
      if (child.type !== 'folder' || !wanted.has(norm(child.name || ''))) continue;
      const lists = (child.children || []).filter((/** @type {any} */ c) => c.type === 'list');
      const qa = lists.find((/** @type {any} */ l) => /\bqa\b/i.test(l.name || '')) || null;
      const main = lists.find((/** @type {any} */ l) => l !== qa) || null;
      return {
        listId: main ? String(main.id) : '',
        qaListId: qa ? String(qa.id) : '',
        folderId: String(child.id),
      };
    }
  }
  return null;
}

/**
 * Every client the workspace knows about, whether or not conventions.json has
 * heard of them: config entries plus every `*-pixelup` channel the bot can
 * see. `registered: false` means writes need a one-tap registration first.
 * @param {{ client: import('@slack/web-api').WebClient, conventions: import('./index.js').Conventions }} args
 * @returns {Promise<Array<{ clientKey: string, displayName: string, registered: boolean, externalChannelId: string, internalChannelId: string }>>}
 */
export async function discoverClients({ client, conventions }) {
  /** @type {Map<string, { clientKey: string, displayName: string, registered: boolean, externalChannelId: string, internalChannelId: string }>} */
  const found = new Map();

  for (const [key, c] of Object.entries(conventions.clients)) {
    found.set(key, {
      clientKey: key,
      displayName: c.display_name || key,
      registered: true,
      externalChannelId: isPlaceholderId(c.channel_id) ? '' : c.channel_id,
      internalChannelId: isPlaceholderId(c.internal_channel_id) ? '' : c.internal_channel_id || '',
    });
  }

  /** @type {string | undefined} */
  let cursor;
  do {
    /** @type {any} */
    let res;
    try {
      res = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor && { cursor }),
      });
    } catch {
      break; // Config-only view is still useful.
    }
    for (const channel of res.channels || []) {
      const { kind, clientKey } = classifyChannelName(channel.name);
      if (!clientKey || kind === 'other') continue;
      const existing = found.get(clientKey);
      const record = existing || {
        clientKey,
        displayName: clientKey,
        registered: false,
        externalChannelId: '',
        internalChannelId: '',
      };
      if (kind === 'client-external') record.externalChannelId = record.externalChannelId || channel.id;
      if (kind === 'client-internal') record.internalChannelId = record.internalChannelId || channel.id;
      found.set(clientKey, record);
      // Cache the name so the guard doesn't re-fetch what we just listed.
      if (channel.id && channel.name) channelCache.set(channel.id, { value: channel.name, at: Date.now() });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return [...found.values()].sort((a, b) => a.clientKey.localeCompare(b.clientKey));
}
