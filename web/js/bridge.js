'use strict';
// Talks to the Velanzo engine, which runs in a background worker (worker.js) with this device's database.
const Engine = (() => {
  let worker = null, seq = 0;
  const pending = new Map();
  function start() {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.out) : p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error('The database stopped: ' + (e.message || 'unknown error')));
      pending.clear();
      worker = null;
    };
  }
  function send(kind, name, args) {
    if (!worker) start();
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, kind, name, args });
    });
  }
  return {
    open: () => send('open'),
    api: (req) => send('api', null, [req]),
    system: (name, ...args) => send('system', name, args),
  };
})();
