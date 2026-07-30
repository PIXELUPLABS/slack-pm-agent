/**
 * Deterministic rules applied to scaffold proposals — in code, so neither the
 * model nor the requester has to remember them.
 */

/**
 * Agency priority rule: the task with the closest due date is urgent, the
 * second closest is high, everything else (including undated tasks) is low.
 * Overwrites whatever priority the model proposed.
 * @template {{ dueDate?: string, priority?: string }} T
 * @param {T[]} tasks
 * @returns {T[]} The same tasks, priorities set.
 */
export function applyDueDatePriorities(tasks) {
  const dated = tasks
    .filter((t) => t.dueDate && !Number.isNaN(Date.parse(t.dueDate)))
    .sort((a, b) => Date.parse(/** @type {string} */ (a.dueDate)) - Date.parse(/** @type {string} */ (b.dueDate)));
  for (const task of tasks) task.priority = 'low';
  if (dated[0]) dated[0].priority = 'urgent';
  if (dated[1]) dated[1].priority = 'high';
  return tasks;
}

/**
 * @param {string} iso @param {number} days @returns {string}
 */
function isoShift(iso, days) {
  return new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Agency calendar rule: weeks run Monday–Friday, so a due date never lands on
 * a weekend — Saturday/Sunday snap BACK to that week's Friday ("end of week N"
 * always means Friday).
 * @param {string | undefined} iso - YYYY-MM-DD
 * @returns {string | undefined}
 */
export function snapDueDateToWeekday(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return iso;
  const day = new Date(Date.parse(iso)).getUTCDay();
  if (day === 6) return isoShift(iso, -1); // Saturday → Friday
  if (day === 0) return isoShift(iso, -2); // Sunday → Friday
  return iso;
}

/**
 * Agency default deadline: the FRIDAY of the current working week. Used when a
 * client request carries no date of its own — "end of week" is the house
 * default, so no intake task lands in ClickUp undated. Saturday/Sunday roll
 * forward to the coming Friday (that work happens next week).
 * @param {Date} [now] - Injectable for tests.
 * @returns {string} YYYY-MM-DD
 */
export function endOfWeek(now = new Date()) {
  const iso = now.toISOString().slice(0, 10);
  const day = new Date(Date.parse(iso)).getUTCDay();
  const daysToFriday = day === 0 ? 5 : day === 6 ? 6 : 5 - day;
  return isoShift(iso, daysToFriday);
}

/**
 * Start dates snap FORWARD to Monday — work doesn't begin on a weekend.
 * @param {string | undefined} iso - YYYY-MM-DD
 * @returns {string | undefined}
 */
export function snapStartDateToWeekday(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return iso;
  const day = new Date(Date.parse(iso)).getUTCDay();
  if (day === 6) return isoShift(iso, 2); // Saturday → Monday
  if (day === 0) return isoShift(iso, 1); // Sunday → Monday
  return iso;
}

/**
 * Resolve a stage name (as the model wrote it) against the configured
 * Project Stage dropdown options. Forgiving match: case-insensitive,
 * substring in either direction ("design" → "visual design").
 * @param {import('../config/index.js').Conventions} conventions
 * @param {string | undefined} stageName
 * @returns {{ name: string, optionId: string } | null}
 */
export function resolveStage(conventions, stageName) {
  const field = conventions.clickup.project_stage_field;
  if (!field || !stageName) return null;
  const needle = stageName.trim().toLowerCase();
  for (const [name, optionId] of Object.entries(field.options)) {
    if (name === needle || name.includes(needle) || needle.includes(name)) {
      return { name, optionId };
    }
  }
  return null;
}
