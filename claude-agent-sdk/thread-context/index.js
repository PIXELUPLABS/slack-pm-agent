import { PendingClientMessageStore } from './pending-client-messages.js';
import { SessionStore } from './store.js';

export const sessionStore = new SessionStore();
export const pendingClientMessages = new PendingClientMessageStore();
