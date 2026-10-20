const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'web', 'js', 'views', 'training.js');
let s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const a = s.indexOf("  {\n    id: 'purchase',");
const b = s.indexOf("  {\n    id: 'newitem',");
if (a < 0 || b < a) throw new Error('guide block not found');
const part = fs.readFileSync(path.join(__dirname, 'po-parts', 'guide.js'), 'utf8').replace(/\r\n/g, '\n').replace(/\\\\/g, '\\');
s = s.slice(0, a) + part + s.slice(b);
// the "Adding a new item" guide: Purchase is now where the order is made
s = s.split('Add the stock with <b>Purchase</b>').join('Add the stock with a <b>Purchase</b> order');
fs.writeFileSync(f, s);
console.log('guide replaced');
