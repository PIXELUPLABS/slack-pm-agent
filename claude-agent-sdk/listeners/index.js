import * as actions from './actions/index.js';
import * as events from './events/index.js';
import * as shortcuts from './shortcuts/index.js';
import * as views from './views/index.js';

/**
 * Register all Slack event, action, shortcut, and view listeners.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function registerListeners(app) {
  actions.register(app);
  events.register(app);
  shortcuts.register(app);
  views.register(app);
}
