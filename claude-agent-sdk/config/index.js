import { readFileSync, writeFileSync } from 'node:fs';

import { isPlaceholderId, resetResolverCache } from './resolver.js';

/**
 * @typedef {Object} ClientConfig
 * @property {string} display_name
 * @property {string} channel_id - External client channel ({key}-pixelup); the bot never posts here.
 * @property {string} [internal_channel_id] - Internal channel ({key}-internal).
 * @property {string} list_id
 * @property {string} qa_list_id
 * @property {string} folder_id
 * @property {string[]} [aliases] - Extra names a meeting title may use for this client (matched case-insensitively).
 * @property {string[]} [email_domains] - Participant email domains that identify this client (e.g. "crossword.ai").
 */

/**
 * @typedef {Object} UserConfig
 * @property {string} name
 * @property {number} clickup_user_id
 * @property {'lead' | 'member'} role
 */

/**
 * @typedef {Object} IssueKindConfig
 * @property {string} tag - ClickUp tag name; must already exist in the space.
 * @property {string} [task_type] - ClickUp task type name (e.g. "Bug"). Omitted → the list's default type.
 */

/**
 * @typedef {Object} InternalListConfig
 * @property {string} display_name
 * @property {string} list_id
 * @property {string} [default_status] - This list has its own status pipeline, separate from clickup.statuses.
 * @property {string} [assignee_slack_id] - Everything logged here is assigned to this person.
 * @property {Record<string, IssueKindConfig>} [kinds] - Tag/type per issue kind (bug, feature).
 */

/**
 * @typedef {Object} Conventions
 * @property {{ name: string, voice: string }} agency
 * @property {{ task_name_format: string, priorities: Record<string, number>, default_priority: string, statuses: string[], default_status: string, qa_statuses?: string[], qa_default_status?: string, project_stage_field?: { id: string, options: Record<string, string> } }} clickup
 * @property {{ list_name: string, tasks: string[] }} [scaffold_template]
 * @property {Record<string, ClientConfig>} clients
 * @property {Record<string, UserConfig>} users
 * @property {Record<string, InternalListConfig>} [internal_lists] - Non-client ClickUp lists (e.g. Automation Ideas in Operations) the agent may log to.
 * @property {{ drafts_channel_id: string, conversation_channel_ids?: string[], registration_alert_slack_id?: string }} channels
 * @property {{ enabled: boolean, days: string[], hour: number, minute: number, timezone: string }} client_updates
 * @property {{ enabled?: boolean, recipient_slack_id?: string, days?: string[], hour?: number, minute?: number, timezone?: string, lookback_hours?: number, monday_lookback_hours?: number, thread_scan_hours?: number, internal_channels?: string[], weekly_review?: { enabled?: boolean, day?: string, lookback_hours?: number, thread_scan_hours?: number } }} [daily_brief] - Morning founder brief from internal channels; `weekly_review` turns one weekday into a week-in-review instead.
 * @property {{ enabled?: boolean, channel_id: string, standup_channel_id?: string, internal_email_domains?: string[], ignore_title_patterns?: string[] }} [meeting_transcripts] - Fireflies transcript → internal recap automation, with daily standup action items routed separately.
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
      for (const listField of ['aliases', 'email_domains']) {
        const value = /** @type {any} */ (client)?.[listField];
        if (
          value !== undefined &&
          (!Array.isArray(value) || value.some((/** @type {any} */ v) => typeof v !== 'string'))
        ) {
          problems.push(`clients.${key}.${listField} must be an array of strings when present`);
        }
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

  if (data.channels && data.channels.conversation_channel_ids !== undefined) {
    if (
      !Array.isArray(data.channels.conversation_channel_ids) ||
      data.channels.conversation_channel_ids.some((/** @type {any} */ id) => typeof id !== 'string')
    ) {
      problems.push('channels.conversation_channel_ids must be an array of strings when present');
    }
  }

  if (data.channels && data.channels.registration_alert_slack_id !== undefined) {
    if (typeof data.channels.registration_alert_slack_id !== 'string') {
      problems.push('channels.registration_alert_slack_id must be a string when present');
    }
  }

  const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  if (data.client_updates) {
    for (const day of data.client_updates.days || []) {
      if (!validDays.includes(day)) problems.push(`client_updates.days contains invalid day "${day}"`);
    }
  }

  if (data.daily_brief !== undefined) {
    const db = data.daily_brief;
    if (!db || typeof db !== 'object') {
      problems.push('daily_brief must be an object when present');
    } else {
      if (db.enabled !== undefined && typeof db.enabled !== 'boolean') {
        problems.push('daily_brief.enabled must be a boolean when present');
      }
      if (db.recipient_slack_id !== undefined && typeof db.recipient_slack_id !== 'string') {
        problems.push('daily_brief.recipient_slack_id must be a string when present');
      }
      if (db.days !== undefined && !Array.isArray(db.days)) {
        problems.push('daily_brief.days must be an array when present');
      } else {
        for (const day of db.days || []) {
          if (!validDays.includes(day)) problems.push(`daily_brief.days contains invalid day "${day}"`);
        }
      }
      for (const field of ['hour', 'minute', 'lookback_hours', 'monday_lookback_hours', 'thread_scan_hours']) {
        const value = db[field];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
          problems.push(`daily_brief.${field} must be a non-negative number when present`);
        }
      }
      if (db.timezone !== undefined && typeof db.timezone !== 'string') {
        problems.push('daily_brief.timezone must be a string when present');
      }
      if (
        db.internal_channels !== undefined &&
        (!Array.isArray(db.internal_channels) ||
          db.internal_channels.some((/** @type {any} */ n) => typeof n !== 'string'))
      ) {
        problems.push('daily_brief.internal_channels must be an array of channel-name strings when present');
      }
      if (db.weekly_review !== undefined) {
        const wr = db.weekly_review;
        if (!wr || typeof wr !== 'object') {
          problems.push('daily_brief.weekly_review must be an object when present');
        } else {
          if (wr.enabled !== undefined && typeof wr.enabled !== 'boolean') {
            problems.push('daily_brief.weekly_review.enabled must be a boolean when present');
          }
          if (wr.day !== undefined && !validDays.includes(wr.day)) {
            problems.push(`daily_brief.weekly_review.day is not a valid day: "${wr.day}"`);
          }
          for (const field of ['lookback_hours', 'thread_scan_hours']) {
            const value = wr[field];
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
              problems.push(`daily_brief.weekly_review.${field} must be a non-negative number when present`);
            }
          }
          // A review day the schedule never fires on would silently never run.
          const day = wr.day || 'monday';
          if (wr.enabled === true && db.days !== undefined && Array.isArray(db.days) && !db.days.includes(day)) {
            problems.push(`daily_brief.weekly_review.day "${day}" is not in daily_brief.days, so it would never run`);
          }
          // The thread scan has to reach further back than the window it briefs on,
          // or a thread whose parent predates the week is invisible.
          if (
            typeof wr.thread_scan_hours === 'number' &&
            typeof wr.lookback_hours === 'number' &&
            wr.thread_scan_hours < wr.lookback_hours
          ) {
            problems.push('daily_brief.weekly_review.thread_scan_hours must be >= its lookback_hours');
          }
        }
      }
      // The scheduler needs somewhere to send it; the CLI can be told at run time.
      if (db.enabled === true && !db.recipient_slack_id) {
        problems.push('daily_brief.recipient_slack_id is required when daily_brief.enabled is true');
      }
    }
  }

  if (data.meeting_transcripts !== undefined) {
    const mt = data.meeting_transcripts;
    if (!mt || typeof mt !== 'object') {
      problems.push('meeting_transcripts must be an object when present');
    } else {
      if (typeof mt.channel_id !== 'string') problems.push('meeting_transcripts.channel_id must be a string');
      if (mt.standup_channel_id !== undefined && typeof mt.standup_channel_id !== 'string') {
        problems.push('meeting_transcripts.standup_channel_id must be a string when present');
      }
      if (mt.enabled !== undefined && typeof mt.enabled !== 'boolean') {
        problems.push('meeting_transcripts.enabled must be a boolean when present');
      }
      if (
        mt.internal_email_domains !== undefined &&
        (!Array.isArray(mt.internal_email_domains) ||
          mt.internal_email_domains.some((/** @type {any} */ d) => typeof d !== 'string'))
      ) {
        problems.push('meeting_transcripts.internal_email_domains must be an array of strings when present');
      }
      if (
        mt.ignore_title_patterns !== undefined &&
        (!Array.isArray(mt.ignore_title_patterns) ||
          mt.ignore_title_patterns.some((/** @type {any} */ p) => typeof p !== 'string'))
      ) {
        problems.push('meeting_transcripts.ignore_title_patterns must be an array of strings when present');
      }
    }
  }

  if (data.internal_lists) {
    for (const [key, list] of Object.entries(data.internal_lists)) {
      for (const field of ['display_name', 'list_id']) {
        if (typeof (/** @type {any} */ (list)?.[field]) !== 'string') {
          problems.push(`internal_lists.${key}.${field} must be a string`);
        }
      }
      const defaultStatus = /** @type {any} */ (list)?.default_status;
      if (defaultStatus !== undefined && typeof defaultStatus !== 'string') {
        problems.push(`internal_lists.${key}.default_status must be a string when present`);
      }
      const assignee = /** @type {any} */ (list)?.assignee_slack_id;
      if (assignee !== undefined && typeof assignee !== 'string') {
        problems.push(`internal_lists.${key}.assignee_slack_id must be a string when present`);
      }
      const kinds = /** @type {any} */ (list)?.kinds;
      if (kinds !== undefined) {
        if (!kinds || typeof kinds !== 'object') {
          problems.push(`internal_lists.${key}.kinds must be an object when present`);
        } else {
          for (const [kind, spec] of Object.entries(kinds)) {
            const s = /** @type {any} */ (spec);
            if (typeof s?.tag !== 'string') problems.push(`internal_lists.${key}.kinds.${kind}.tag must be a string`);
            if (s?.task_type !== undefined && typeof s.task_type !== 'string') {
              problems.push(`internal_lists.${key}.kinds.${kind}.task_type must be a string when present`);
            }
          }
        }
      }
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

const GUIDELINES_TEMPLATE_PATH = new URL('./engagement-guidelines-template.md', import.meta.url);

/** @type {string | null} */
let guidelinesTemplateCache = null;

/**
 * Load the house engagement-guidelines template — the versioned structure the
 * agent fills when drafting guidelines v1 from a project scope. House terms
 * (revision rounds, care window, boilerplate sections) live HERE, in git, so
 * changing them is a config edit, never a prompt edit. `[TBD: …]` slots mark
 * what a scope must supply; the model may never fill one with a guess.
 * @param {{ path?: URL | string, force?: boolean }} [options]
 * @returns {string}
 */
export function loadGuidelinesTemplate(options = {}) {
  if (guidelinesTemplateCache && !options.force && !options.path) return guidelinesTemplateCache;
  const path = options.path || process.env.GUIDELINES_TEMPLATE_PATH || GUIDELINES_TEMPLATE_PATH;
  const text = readFileSync(path, 'utf8');
  /** @type {string[]} */
  const problems = [];
  if (!text.includes('{Client}')) problems.push('missing the {Client} token');
  const sections = (text.match(/^## \d+\./gm) || []).length;
  if (sections < 10) problems.push(`expected 10 numbered "## N." sections, found ${sections}`);
  if (!text.includes('[TBD:')) problems.push('missing [TBD: …] placeholder slots');
  if (problems.length > 0) {
    throw new Error(`engagement-guidelines-template.md is invalid:\n- ${problems.join('\n- ')}`);
  }
  if (!options.path) guidelinesTemplateCache = text;
  return text;
}

/** Reset the template cache (tests). @returns {void} */
export function resetGuidelinesTemplateCache() {
  guidelinesTemplateCache = null;
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
  // Drop memoized lookups too — a newly registered client's overrides must take
  // effect immediately, not after the resolver TTL expires.
  resetResolverCache();
  return loadConventions();
}

/**
 * Config-only channel→client lookup. Ignores unfilled placeholder IDs
 * (`C_TODO_ACME`), which would otherwise "match" nothing while looking like a
 * real mapping. Callers that need live resolution by channel NAME should use
 * `resolveChannelContext` from ./resolver.js instead.
 * @param {Conventions} conventions
 * @param {string} channelId
 * @returns {{ key: string, client: ClientConfig } | null}
 */
export function findClientByChannel(conventions, channelId) {
  if (!channelId) return null;
  for (const [key, client] of Object.entries(conventions.clients)) {
    if (!isPlaceholderId(client.channel_id) && client.channel_id === channelId) return { key, client };
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
 * Config-only view of "may converse here": any channel that is not a CONFIGURED
 * client channel.
 *
 * NOT THE GUARD. It answers `true` for channels config has never heard of,
 * which is exactly how a client channel with an unfilled `channel_id` came to
 * be treated as a normal internal channel. Listeners must use
 * `canBotPostInChannel` from ./resolver.js, which decides by channel name and
 * fails closed on an unidentifiable channel.
 * @param {Conventions} conventions
 * @param {string} channelId
 * @returns {boolean}
 */
export function isConversationChannel(conventions, channelId) {
  if (!channelId) return false;
  return !isClientChannel(conventions, channelId);
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
 * True when a priority name is defined in conventions. An empty/undefined name
 * is valid — callers fall back to default_priority for the omitted case.
 * @param {Conventions} conventions
 * @param {string | undefined} priorityName
 * @returns {boolean}
 */
export function isKnownPriority(conventions, priorityName) {
  if (!priorityName) return true;
  return priorityName in conventions.clickup.priorities;
}

/**
 * All known status names (project + QA pipelines). A task update may target a
 * client list or a QA list, so both sets are valid.
 * @param {Conventions} conventions
 * @returns {string[]}
 */
export function knownStatuses(conventions) {
  return [...conventions.clickup.statuses, ...(conventions.clickup.qa_statuses || [])];
}

/**
 * Resolve a status name to its canonical config casing (case-insensitive),
 * across both pipelines. Returns null when the status is unknown — so callers
 * can reject it before the card instead of failing the write after approval.
 * @param {Conventions} conventions
 * @param {string | undefined} statusName
 * @returns {string | null}
 */
export function resolveStatus(conventions, statusName) {
  if (!statusName) return null;
  return knownStatuses(conventions).find((s) => s.toLowerCase() === statusName.toLowerCase()) ?? null;
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
  if (conventions.internal_lists?.automation_ideas) {
    lines.push(
      'Automation ideas: anyone on the team can float a process-automation idea — use propose_automation_idea ' +
        'to log it in the internal Automation Ideas list. Not client work; no lead gate.',
    );
  }
  return lines.join('\n');
}
