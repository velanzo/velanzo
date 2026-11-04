// Start the app: open this device's database, then set up the device, ask who's working, or go straight in.
import { createCloud } from './cloud.js';

window.Cloud = createCloud();
window.addEventListener('hashchange', router);
Setup.start();

// Works offline and can be installed ("Install app" in Chrome / Edge, "Add to Home screen" on phones).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadOne = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // A window left open for days still looks for new versions.
    setInterval(() => reg.update().catch(() => {}), 3600000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  // A new version arrived while this window is open: every computer should run the same one.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadOne || document.getElementById('newVersion')) return;
    const bar = document.createElement('div');
    bar.id = 'newVersion';
    bar.className = 'toast ok new-version';
    bar.innerHTML = 'A new version of Velanzo is ready. <button class="btn sm">Restart now</button>';
    bar.querySelector('button').addEventListener('click', () => location.reload());
    document.getElementById('toasts')?.appendChild(bar);
  });
}
