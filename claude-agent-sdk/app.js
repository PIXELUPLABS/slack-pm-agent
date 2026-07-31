import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { loadConventions } from './config/index.js';
import { registerListeners } from './listeners/index.js';
import { startClientUpdateScheduler } from './schedules/client-updates.js';
import { startDailyBriefScheduler } from './schedules/daily-brief.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
  ignoreSelf: false,
});

registerListeners(app);

(async () => {
  loadConventions(); // Fail fast on invalid conventions before going online.
  await app.start();
  app.logger.info('Pixelup Bot is running!');
  startClientUpdateScheduler(app.client, app.logger);
  startDailyBriefScheduler(app.client, app.logger);
})();
