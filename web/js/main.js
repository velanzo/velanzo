// Start the app: open this device's database, then set up the device, ask who's working, or go straight in.
import { createCloud } from './cloud.js';

window.Cloud = createCloud();
window.addEventListener('hashchange', router);
Setup.start();

// Works offline and can be installed ("Install app" in Chrome / Edge, "Add to Home screen" on phones).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
