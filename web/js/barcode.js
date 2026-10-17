'use strict';
// Code 128 barcode → SVG. Code 128 is read by every normal barcode scanner.
const Barcode = (() => {
  const P = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];
  const START_B = 104, START_C = 105, CODE_B = 100, STOP = 106;

  // Returns the bar/space widths (in modules) for the text.
  function encode(text) {
    text = String(text);
    const codes = [];
    if (/^\d{2,}$/.test(text)) {
      // digits only: pack two digits per symbol (shorter barcode)
      codes.push(START_C);
      let i = 0;
      for (; i + 1 < text.length; i += 2) codes.push(parseInt(text.substr(i, 2), 10));
      if (i < text.length) codes.push(CODE_B, text.charCodeAt(i) - 32);
    } else {
      codes.push(START_B);
      for (const ch of text) {
        let c = ch.charCodeAt(0);
        if (c < 32 || c > 126) c = 63; // '?'
        codes.push(c - 32);
      }
    }
    let sum = codes[0];
    for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103, STOP);
    return codes.map((c) => P[c]).join('');
  }

  function svg(text, { height = 50, quiet = 10, cls = 'bc' } = {}) {
    const widths = encode(text);
    let x = quiet, bars = '';
    for (let i = 0; i < widths.length; i++) {
      const w = +widths[i];
      if (i % 2 === 0) bars += `M${x} 0h${w}v${height}h-${w}z`;
      x += w;
    }
    const total = x + quiet;
    return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${total}" height="${height}" fill="#fff"/><path d="${bars}" fill="#000"/></svg>`;
  }

  return { encode, svg, PATTERNS: P };
})();
if (typeof module !== 'undefined') module.exports = Barcode;
