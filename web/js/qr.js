'use strict';
// QR code → SVG, made here (no library, works offline). Short text only (up to about 150 characters), error correction level M.
// Voucher codes are printed as QR codes; a normal barcode scanner reads them and types the text, like a keyboard.
const QR = (() => {
  // [errorCodewordsPerBlock, [[blocks, dataCodewordsPerBlock], ...]] for versions 1..10, level M
  const BLOCKS = [
    null,
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // ----- Reed-Solomon over GF(256) -----
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
      g = next;
    }
    return g;
  }
  function remainder(data, n) {
    const g = generator(n), r = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ r.shift();
      r.push(0);
      if (f) for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f);
    }
    return r;
  }

  const dataSize = (v) => BLOCKS[v][1].reduce((a, [n, d]) => a + n * d, 0);
  const bch = (value, poly, bits) => { // value shifted up, remainder of the division by poly
    let x = value << bits;
    const top = (n) => 31 - Math.clz32(n);
    while (x && top(x) >= top(poly)) x ^= poly << (top(x) - top(poly));
    return x;
  };

  function codewords(bytes) {
    let v = 1;
    for (; v <= 10; v++) if (bytes.length + (v < 10 ? 2 : 3) <= dataSize(v)) break;
    if (v > 10) throw new Error('QR: text too long');
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const cap = dataSize(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < dataSize(v); pad ^= 0xec ^ 0x11) data.push(pad);
    // split into blocks, add error correction, interleave
    const [ec, groups] = BLOCKS[v];
    const blocks = [];
    let at = 0;
    for (const [n, d] of groups) for (let i = 0; i < n; i++) { const part = data.slice(at, at + d); at += d; blocks.push({ data: part, ec: remainder(part, ec) }); }
    const out = [];
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
    return { v, out };
  }

  function build(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const { v, out } = codewords(bytes);
    const n = 17 + 4 * v;
    const M = Array.from({ length: n }, () => new Array(n).fill(false));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // function patterns: data does not go here
    const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < n && y < n) { M[y][x] = dark; fn[y][x] = true; } };

    // finder patterns with their separators
    for (const [cx, cy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
        const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        set(cx + dx, cy + dy, dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (edge || core));
      }
    }
    // timing lines
    for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
    // alignment patterns (not where a finder pattern is)
    const pos = ALIGN[v];
    for (const cy of pos) for (const cx of pos) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos[pos.length - 1]) || (cx === pos[pos.length - 1] && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // the always-dark module and the places for the format and version bits
    set(8, n - 8, true);
    for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(i, 8, false); if (!fn[i][8]) set(8, i, false); }
    for (let i = 0; i < 8; i++) { set(n - 1 - i, 8, false); set(8, n - 1 - i, false); }
    set(8, n - 8, true);
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(n - 11 + j, i, false); set(i, n - 11 + j, false); }

    // data bits, in the zig-zag order (two columns at a time, from the right, skipping the timing column)
    const bits = [];
    for (const b of out) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    const cells = [];
    for (let right = n - 1, up = true; right >= 1; right -= 2, up = !up) {
      if (right === 6) right = 5;
      for (let k = 0; k < n; k++) {
        const y = up ? n - 1 - k : k;
        for (let c = 0; c < 2; c++) { const x = right - c; if (!fn[y][x]) cells.push([x, y]); }
      }
    }
    cells.forEach(([x, y], i) => { M[y][x] = i < bits.length ? bits[i] === 1 : false; });

    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const withMask = (m) => {
      const G = M.map((row) => row.slice());
      for (const [x, y] of cells) if (MASKS[m](x, y)) G[y][x] = !G[y][x];
      // format bits: level M = 00, then the mask number
      const f = (((0 << 3) | m) << 10 | bch((0 << 3) | m, 0x537, 10)) ^ 0x5412;
      const bit = (i) => ((f >> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) G[i][8] = bit(i);
      G[7][8] = bit(6); G[8][8] = bit(7); G[8][7] = bit(8);
      for (let i = 9; i < 15; i++) G[8][14 - i] = bit(i);
      for (let i = 0; i < 8; i++) G[8][n - 1 - i] = bit(i);
      for (let i = 8; i < 15; i++) G[n - 15 + i][8] = bit(i);
      G[n - 8][8] = true;
      if (v >= 7) {
        const info = (v << 12) | bch(v, 0x1f25, 12);
        for (let i = 0; i < 18; i++) { const b = ((info >> i) & 1) === 1, a = Math.floor(i / 3), c = i % 3 + n - 11; G[a][c] = b; G[c][a] = b; }
      }
      return G;
    };
    const penalty = (G) => {
      let p = 0;
      for (let pass = 0; pass < 2; pass++) { // rows, then columns
        for (let a = 0; a < n; a++) {
          let run = 1;
          for (let b = 1; b < n; b++) {
            const cur = pass ? G[b][a] : G[a][b], prev = pass ? G[b - 1][a] : G[a][b - 1];
            if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
          }
          for (let b = 0; b + 10 < n; b++) { // 1:1:3:1:1 with four light modules beside it
            const at = (i) => (pass ? G[b + i][a] : G[a][b + i]);
            const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
            let m1 = true, m2 = true;
            for (let i = 0; i < 11; i++) { const d = at(i) ? 1 : 0; if (d !== pat1[i]) m1 = false; if (d !== pat2[i]) m2 = false; }
            if (m1) p += 40;
            if (m2) p += 40;
          }
        }
      }
      for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (G[y][x] === G[y][x + 1] && G[y][x] === G[y + 1][x] && G[y][x] === G[y + 1][x + 1]) p += 3;
      let dark = 0;
      for (const row of G) for (const c of row) if (c) dark++;
      p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
      return p;
    };
    let best = null, bestP = Infinity;
    for (let m = 0; m < 8; m++) { const G = withMask(m); const p = penalty(G); if (p < bestP) { bestP = p; best = G; } }
    return { size: n, version: v, modules: best };
  }

  // Svg: `moduleMm` = size of one square in millimetres (0.75 reads well; a whole number of printer dots is sharpest), 4 squares of quiet zone.
  function svg(text, { moduleMm = 0.75, quiet = 4, cls = '' } = {}) {
    const q = build(text), N = q.size + quiet * 2;
    let d = '';
    for (let y = 0; y < q.size; y++) {
      let x = 0;
      while (x < q.size) {
        if (!q.modules[y][x]) { x++; continue; }
        let w = 1;
        while (x + w < q.size && q.modules[y][x + w]) w++;
        d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
        x += w;
      }
    }
    const mm = (N * moduleMm).toFixed(2);
    return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${mm}mm" height="${mm}mm" shape-rendering="crispEdges"><rect width="${N}" height="${N}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  return { build, svg };
})();
if (typeof module !== 'undefined') module.exports = QR;
