import { handleAddToClickUp } from './add-to-clickup.js';

/**
 * Register shortcut listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.shortcut('add_to_clickup', handleAddToClickUp);
}
