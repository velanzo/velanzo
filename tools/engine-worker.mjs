// One device for tests: its own engine and database in a worker thread.
import { parentPort } from 'node:worker_threads';
import * as E from '../web/engine/index.js';
import { nodeAdapter } from '../web/engine/node-adapter.js';
import * as D from '../web/engine/db.js';

E.init(nodeAdapter());
parentPort.on('message', async ({ id, kind, name, args }) => {
  try {
    let out;
    if (kind === 'api') out = await E.handle(args[0]);
    else if (kind === 'sql') out = D.all(args[0], ...(args[1] || []));
    else if (kind === 'clock') { const ms = args[0]; globalThis.__vzClock = ms == null ? undefined : () => new Date(ms); out = true; }
    else out = await E.system[name](...args);
    parentPort.postMessage({ id, ok: true, out });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
