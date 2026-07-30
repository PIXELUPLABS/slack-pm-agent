import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FileOAuthProvider } from './mcp-auth.js';
import { CLICKUP_MCP, serverToken, serverUrl } from './mcp-servers.js';

/**
 * Deterministic ClickUp writes over the ClickUp MCP server.
 *
 * This module is the executor's write path: it connects as an MCP client and
 * calls exactly one named tool per operation. Only create/update tool names
 * exist here — there is no delete call anywhere (hard rule), and the agent
 * never touches this module; it runs post-approval from listener code only.
 *
 * Tool names and argument shapes verified against the live hosted server on
 * 2026-07-13 (tools/list): create/update tasks take `markdown_description`,
 * `priority` as a name string, and `due_date` as a date string.
 */

const WRITE_TOOLS = {
  createTask: 'clickup_create_task',
  updateTask: 'clickup_update_task',
  moveTask: 'clickup_move_task',
  createListInFolder: 'clickup_create_list_in_folder',
  addTaskDependency: 'clickup_add_task_dependency',
  attachTaskFile: 'clickup_attach_task_file',
};

/** ClickUp's canonical priority names, keyed by numeric priority. */
const PRIORITY_NAMES = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };

/**
 * Translate the executor's task fields into the MCP tool's argument shape.
 * @param {Partial<TaskFields>} fields
 * @returns {Record<string, any>}
 */
export function toMcpTaskArgs(fields) {
  /** @type {Record<string, any>} */
  const args = {};
  if (fields.name !== undefined) args.name = fields.name;
  if (fields.description) args.markdown_description = fields.description;
  if (fields.priority !== undefined) {
    args.priority = PRIORITY_NAMES[/** @type {1|2|3|4} */ (fields.priority)] || String(fields.priority);
  }
  if (fields.due_date !== undefined) args.due_date = new Date(fields.due_date).toISOString().slice(0, 10);
  if (fields.start_date !== undefined) args.start_date = new Date(fields.start_date).toISOString().slice(0, 10);
  // The MCP tool validates assignees as an array of STRINGS (verified live).
  // An explicit clear sends an empty list (removes everyone); otherwise a
  // non-empty list replaces the set. A bare empty array is a no-op.
  if (fields.clear_assignees) {
    args.assignees = [];
  } else if (Array.isArray(fields.assignees) && fields.assignees.length > 0) {
    args.assignees = fields.assignees.map(String);
  }
  if (fields.status) args.status = fields.status;
  if (fields.parent) args.parent = fields.parent;
  if (Array.isArray(fields.tags) && fields.tags.length > 0) args.tags = fields.tags;
  // ClickUp task type by NAME ("Bug", "Feature"); must exist in the workspace.
  if (fields.task_type) args.task_type = fields.task_type;
  // The MCP tool takes time_estimate as a string count of minutes (verified live).
  if (fields.time_estimate !== undefined) args.time_estimate = String(fields.time_estimate);
  if (Array.isArray(fields.custom_fields) && fields.custom_fields.length > 0) {
    args.custom_fields = fields.custom_fields;
  }
  return args;
}

export class ClickUpMcpError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ClickUpMcpError';
  }
}

/**
 * Open a short-lived MCP client connection. Approvals are infrequent, so a
 * connection per operation keeps things simple and never goes stale.
 *
 * Auth: OAuth via the shared FileOAuthProvider (the SDK transport refreshes
 * tokens automatically on 401), or a static CLICKUP_MCP_TOKEN override.
 * @returns {Promise<{ client: Client, close: () => Promise<void> }>}
 */
async function connect() {
  const url = new URL(serverUrl(CLICKUP_MCP));
  const staticToken = serverToken(CLICKUP_MCP);

  /** @type {StreamableHTTPClientTransport} */
  let transport;
  if (staticToken) {
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${staticToken}` } },
    });
  } else {
    const provider = new FileOAuthProvider(CLICKUP_MCP.key);
    if (!provider.tokens()?.access_token) {
      throw new ClickUpMcpError(
        'ClickUp MCP is not authorized yet — run `npm run auth:clickup` once (or set CLICKUP_MCP_TOKEN).',
      );
    }
    transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  }

  const client = new Client({ name: 'pixelup-bot-executor', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/**
 * Call one ClickUp MCP tool and return its text content.
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @returns {Promise<string>}
 */
async function callTool(toolName, args) {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((/** @type {any} */ block) => block.type === 'text')
      .map((/** @type {any} */ block) => block.text)
      .join('\n');
    if (result.isError) {
      throw new ClickUpMcpError(`ClickUp MCP tool ${toolName} failed: ${text || 'unknown error'}`);
    }
    return text;
  } finally {
    await close().catch(() => {});
  }
}

/**
 * Best-effort extraction of structured fields from an MCP text response —
 * servers usually return JSON text; fall back to regex for the essentials.
 * @param {string} text
 * @returns {{ id?: string, url?: string }}
 */
export function extractTaskRef(text) {
  try {
    const parsed = JSON.parse(text);
    const node = parsed.task || parsed.list || parsed;
    // The hosted server varies its key names by tool: id / task_id / list_id.
    const id = node.id ?? node.task_id ?? node.list_id;
    const url = node.url ?? node.task_url ?? node.list_url;
    return { id: id !== undefined ? String(id) : undefined, url };
  } catch {
    const url = text.match(/https:\/\/app\.clickup\.com\/t\/[\w-]+/)?.[0];
    const id = text.match(/"(?:id|task_id|list_id)"\s*:\s*"?([\w-]+)"?/)?.[1];
    return { id, url };
  }
}

/**
 * @typedef {Object} TaskFields
 * @property {string} name
 * @property {string} [description]
 * @property {number} [priority] - ClickUp numeric priority (1 urgent … 4 low).
 * @property {number} [due_date] - Unix ms timestamp.
 * @property {number} [start_date] - Unix ms timestamp.
 * @property {number[]} [assignees] - ClickUp user IDs.
 * @property {boolean} [clear_assignees] - Remove all assignees (sends an empty list).
 * @property {string} [status]
 * @property {string} [parent] - Parent task ID; creates this task as a subtask.
 * @property {string[]} [tags] - Tag names (must already exist in the space).
 * @property {string} [task_type] - ClickUp task type name (e.g. "Bug"); must exist in the workspace.
 * @property {number} [time_estimate] - Time estimate in minutes.
 * @property {Array<{ id: string, value: any }>} [custom_fields]
 */

/**
 * Create a task in a list.
 * @param {string} listId
 * @param {TaskFields} fields
 * @returns {Promise<{ id: string | undefined, name: string, url: string | undefined }>}
 */
export async function createTask(listId, fields) {
  const text = await callTool(WRITE_TOOLS.createTask, { list_id: listId, ...toMcpTaskArgs(fields) });
  const ref = extractTaskRef(text);
  return { id: ref.id, name: fields.name, url: ref.url };
}

/**
 * Update fields on an existing task.
 * @param {string} taskId
 * @param {Partial<TaskFields>} fields
 * @returns {Promise<{ id: string, name: string, url: string | undefined }>}
 */
export async function updateTask(taskId, fields) {
  const text = await callTool(WRITE_TOOLS.updateTask, { task_id: taskId, ...toMcpTaskArgs(fields) });
  const ref = extractTaskRef(text);
  return { id: taskId, name: fields.name || taskId, url: ref.url };
}

/**
 * Move a task to a different home list.
 * @param {string} taskId
 * @param {string} listId - Destination list ID.
 * @returns {Promise<void>}
 */
export async function moveTask(taskId, listId) {
  await callTool(WRITE_TOOLS.moveTask, { task_id: taskId, list_id: listId });
}

/**
 * Link two tasks: `taskId` waits on (is blocked by) `dependsOnTaskId`.
 * @param {string} taskId
 * @param {string} dependsOnTaskId
 * @returns {Promise<void>}
 */
export async function addTaskDependency(taskId, dependsOnTaskId) {
  await callTool(WRITE_TOOLS.addTaskDependency, { task_id: taskId, depends_on: dependsOnTaskId, type: 'waiting_on' });
}

/**
 * Read the workspace hierarchy (spaces → folders → lists). Read-only; used by
 * the client-registration flow to locate a client's folder and lists.
 * @returns {Promise<any>} The hierarchy root node.
 */
export async function getHierarchy() {
  const text = await callTool('clickup_get_workspace_hierarchy', { max_depth: '2', limit: 50 });
  const data = JSON.parse(text);
  return data.hierarchy?.root;
}

/**
 * Attach a file to a task by uploading its BYTES (base64), not by handing
 * ClickUp a URL. The screenshots come from Slack behind `url_private`, and the
 * URL form of this tool would require passing our Slack bot token to the
 * ClickUp MCP server as an `auth_header` — the token stays on our side instead.
 * @param {string} taskId
 * @param {{ fileName: string, data: Buffer }} file
 * @returns {Promise<void>}
 */
export async function attachTaskFile(taskId, file) {
  await callTool(WRITE_TOOLS.attachTaskFile, {
    task_id: taskId,
    file_name: file.fileName,
    file_data: file.data.toString('base64'),
  });
}

/**
 * Create a list inside a folder (used by approved project scaffolds).
 * @param {string} folderId
 * @param {string} name
 * @returns {Promise<{ id: string, name: string }>}
 */
export async function createList(folderId, name) {
  const text = await callTool(WRITE_TOOLS.createListInFolder, { folder_id: folderId, name });
  const ref = extractTaskRef(text);
  if (!ref.id) {
    throw new ClickUpMcpError(
      `Could not determine the new list's ID from the ClickUp MCP response: ${text.slice(0, 200)}`,
    );
  }
  return { id: ref.id, name };
}
