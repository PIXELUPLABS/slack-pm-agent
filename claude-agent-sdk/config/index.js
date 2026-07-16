import { readFileSync, writeFileSync } from 'node:fs';

/**
 * @typedef {Object} ClientConfig
 * @property {string} display_name
 * @property {string} channel_id - External client channel ({key}-pixelup); the bot never posts here.
 * @property {string} [internal_channel_id] - Internal channel ({key}-internal).
 * @property {string} list_id
 * @property {string} qa_list_id
 * @property {string} folder_id
 */

/**
 * @typedef {Object} UserConfig
 * @property {string} name
 * @property {number} clickup_user_id
 * @property {'lead' | 'member'} role
 */

/**
 * @typedef {Object} Conventions
 * @property {{ name: string, voice: string }} agency
 * @property {{ task_name_format: string, priorities: Record<string, number>, default_priority: string, statuses: string[], default_status: string, qa_statuses?: string[], qa_default_status?: string, project_stage_field?: { id: string, options: Record<string, string> } }} clickup
 * @property {{ list_name: string, tasks: string[] }} [scaffold_template]
 * @property {Record<string, ClientConfig>} clients
 * @property {Record<string, UserConfig>} users
 * @property {{ drafts_channel_id: string }} channels
 * @property {{ enabled: boolean, days: string[], hour: number, minute: number, timezone: string }} client_updates
 */

const DEFAULT_PATH = new URL('./conventions.json', import.meta.url);

/** @type {Conventions | null} */
let cached = null;

/**
 * Validate the conventions shape, throwing a single error listing every problem.
 * @param {any} data
 * @returns {Conventions}
 */
export function validateConventions(data) {
  /** @type {string[]} */
  const problems = [];

  if (!data || typeof data !== 'object') {
    throw new Error('conventions.json: file must contain a JSON object');
  }

  for (const key of ['agency', 'clickup', 'clients', 'users', 'channels', 'client_updates']) {
    if (!data[key] || typeof data[key] !== 'object') problems.push(`missing or invalid "${key}" section`);
  }

  if (data.clickup) {
    if (typeof data.clickup.task_name_format !== 'string') problems.push('clickup.task_name_format must be a string');
    if (!data.clickup.priorities || typeof data.clickup.priorities !== 'object') {
      problems.push('clickup.priorities must be an object');
    } else if (data.clickup.default_priority && !(data.clickup.default_priority in data.clickup.priorities)) {
      problems.push(`clickup.default_priority "${data.clickup.default_priority}" is not in clickup.priorities`);
    }
  }

  if (data.clients) {
    for (const [key, client] of Object.entries(data.clients)) {
      for (const field of ['display_name', 'channel_id', 'list_id', 'qa_list_id', 'folder_id']) {
        if (typeof (/** @type {any} */ (client)?.[field]) !== 'string') {
          problems.push(`clients.${key}.${field} must be a string`);
        }
      }
      const internal = /** @type {any} */ (client)?.internal_channel_id;
      if (internal !== undefined && typeof internal !== 'string') {
        problems.push(`clients.${key}.internal_channel_id must be a string when present`);
      }
    }
  }

  if (data.users) {
    for (const [slackId, user] of Object.entries(data.users)) {
      const u = /** @type {any} */ (user);
      if (typeof u?.name !== 'string') problems.push(`users.${slackId}.name must be a string`);
      if (typeof u?.clickup_user_id !== 'number') problems.push(`users.${slackId}.clickup_user_id must be a number`);
      if (u?.role !== 'lead' && u?.role !== 'member') problems.push(`users.${slackId}.role must be "lead" or "member"`);
    }
  }

  if (data.client_updates) {
    const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const day of data.client_updates.days || []) {
      if (!validDays.includes(day)) problems.push(`client_updates.days contains invalid day "${day}"`);
    }
  }

  if (data.scaffold_template) {
    if (typeof data.scaffold_template.list_name !== 'string') {
      problems.push('scaffold_template.list_name must be a string');
    }
    if (!Array.isArray(data.scaffold_template.tasks) || data.scaffold_template.tasks.length === 0) {
      problems.push('scaffold_template.tasks must be a non-empty array');
    }
  }

  if (data.clickup?.qa_default_status && data.clickup.qa_statuses) {
    if (!data.clickup.qa_statuses.includes(data.clickup.qa_default_status)) {
      problems.push(`clickup.qa_default_status "${data.clickup.qa_default_status}" is not in clickup.qa_statuses`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`conventions.json is invalid:\n- ${problems.join('\n- ')}`);
  }

  return /** @type {Conventions} */ (data);
}

/**
 * Load conventions from disk (cached after first load — single source of truth, loaded at startup).
 * CONVENTIONS_PATH overrides the default file (tests point this at a fixture).
 * @param {{ path?: URL | string, force?: boolean }} [options]
 * @returns {Conventions}
 */
export function loadConventions(options = {}) {
  if (cached && !options.force && !options.path) return cached;
  const raw = readFileSync(options.path || process.env.CONVENTIONS_PATH || DEFAULT_PATH, 'utf8');
  const parsed = validateConventions(JSON.parse(raw));
  if (!options.path) cached = parsed;
  return parsed;
}

/** Reset the cache (config writes and tests). @returns {void} */
export function resetConventionsCache() {
  cached = null;
}

/**
 * Add a client to conventions.json (the deterministic write behind an
 * approved client registration) and reload the cache so the running bot
 * picks it up without a restart.
 * @param {string} clientKey
 * @param {ClientConfig} entry
 * @param {{ path?: URL | string }} [options]
 * @returns {Conventions}
 */
export function addClientToConventions(clientKey, entry, options = {}) {
  const path = options.path || process.env.CONVENTIONS_PATH || DEFAULT_PATH;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.clients?.[clientKey]) {
    throw new Error(`Client "${clientKey}" already exists in conventions.json.`);
  }
  data.clients[clientKey] = entry;
  const validated = validateConventions(data);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
  resetConventionsCache();
  return loadConventions();
}

/**
 * @param {Conventions} conventions
 * @param {string} channelId
 * @returns {{ key: string, client: ClientConfig } | null}
 */
export function findClientByChannel(conventions, channelId) {
  for (const [key, client] of Object.entries(conventions.clients)) {
    if (client.channel_id === channelId) return { key, client };
  }
  return null;
}

/**
 * @param {Conventions} conventions
 * @param {string} channelId
 * @returns {boolean}
 */
export function isClientChannel(conventions, channelId) {
  return findClientByChannel(conventions, channelId) !== null;
}

/**
 * Channels the bot is allowed to CONVERSE in (beyond DMs): the clients'
 * internal channels and the drafts channel. Everything else — client
 * channels, general channels, anything unmapped — is read-only silence.
 * @param {Conventions} conventions
 * @param {string} channelId
 * @returns {boolean}
 */
export function isConversationChannel(conventions, channelId) {
  if (!channelId) return false;
  if (conventions.channels.drafts_channel_id === channelId) return true;
  for (const client of Object.values(conventions.clients)) {
    if (client.internal_channel_id === channelId) return true;
  }
  return false;
}

/**
 * @param {Conventions} conventions
 * @param {string} slackUserId
 * @returns {boolean}
 */
export function isLead(conventions, slackUserId) {
  return conventions.users[slackUserId]?.role === 'lead';
}

/**
 * @param {Conventions} conventions
 * @param {string} slackUserId
 * @returns {number | null}
 */
export function getClickUpUserId(conventions, slackUserId) {
  return conventions.users[slackUserId]?.clickup_user_id ?? null;
}

/**
 * Resolve a ClickUp numeric priority from a priority name, falling back to the default.
 * @param {Conventions} conventions
 * @param {string | undefined} priorityName
 * @returns {number}
 */
export function resolvePriority(conventions, priorityName) {
  const { priorities, default_priority } = conventions.clickup;
  return priorities[priorityName || default_priority] ?? priorities[default_priority];
}

/**
 * Format a task name per the naming convention.
 * @param {Conventions} conventions
 * @param {string} clientKey
 * @param {string} title
 * @returns {string}
 */
export function formatTaskName(conventions, clientKey, title) {
  const display = conventions.clients[clientKey]?.display_name || clientKey;
  return conventions.clickup.task_name_format.replace('{client}', display).replace('{title}', title);
}

/**
 * Compact conventions summary for the system prompt. Client list/channel IDs
 * stay out (the executor resolves them); team ClickUp IDs are included so the
 * agent can filter ClickUp MCP reads per person.
 * @param {Conventions} conventions
 * @returns {string}
 */
export function conventionsSummary(conventions) {
  const clients = Object.entries(conventions.clients)
    .map(([key, c]) => `${key} (${c.display_name})`)
    .join(', ');
  const team = Object.entries(conventions.users)
    .map(([slackId, u]) => `${u.name} (${u.role}, Slack ${slackId}, ClickUp ${u.clickup_user_id})`)
    .join('; ');
  const lines = [
    `Clients (use these keys): ${clients}`,
    `Priorities: ${Object.keys(conventions.clickup.priorities).join(', ')} (default ${conventions.clickup.default_priority})`,
    `Task naming: ${conventions.clickup.task_name_format}`,
    `Project statuses: ${conventions.clickup.statuses.join(', ')}`,
    `Team: ${team}`,
    `Voice for client updates: ${conventions.agency.voice}`,
  ];
  if (conventions.clickup.qa_statuses) {
    lines.push(`QA list statuses: ${conventions.clickup.qa_statuses.join(', ')}`);
  }
  if (conventions.scaffold_template) {
    lines.push(
      `Standard project scaffold — client folders are duplicated from the demo template, so the engagement list (e.g. "${conventions.scaffold_template.list_name}") and QA list already exist, possibly with starter tasks. Scaffolding ADDS milestone tasks to the existing engagement list; read its current tasks first and only propose missing milestones. Milestone order: ${conventions.scaffold_template.tasks.join(' → ')}. Adapt names/dates to the engagement doc; drop brand tasks for web-only engagements.`,
    );
  }
  if (conventions.clickup.project_stage_field) {
    lines.push(
      `Scaffold task stages (set stage per task; it drives the board grouping): ${Object.keys(conventions.clickup.project_stage_field.options).join(', ')}. Task priorities on scaffolds are set by code from due dates (closest urgent, second high, rest low) — do not set them yourself.`,
    );
  }
  return lines.join('\n');
}
