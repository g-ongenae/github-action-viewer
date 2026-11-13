// Entry point of the page, loaded by index.html as a module.

import { App } from './app.ts';
import { Connection } from './connection.ts';

/** Relative times ("12 s ago") are re-rendered this often. */
const TICK_MS = 1000;

const app = new App(document);
const connection = new Connection({
  url: '/api/events',
  onPayload: (payload) => {
    app.setPayload(payload);
  },
  onHeartbeat: (heartbeat) => {
    app.applyHeartbeat(heartbeat);
  },
  onStateChange: (state) => {
    app.setConnection(state);
  },
});
connection.start();
setInterval(() => {
  app.render();
}, TICK_MS);
