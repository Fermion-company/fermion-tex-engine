// Font metrics for the layout engine.
//
// The engine must be able to measure text deterministically, without a
// rasterizer. We embed advance-width tables (per-mille of font size) for the
// four core faces used by the runtime. The viewer positions every word box at
// the exact x computed here, so layout is engine-authoritative: the browser
// font only has to look similar, never to agree on widths.

// Adobe core Times-Roman advance widths (1/1000 em).
const TIMES_REGULAR = {
  ' ': 250, '!': 333, '"': 408, '#': 500, '$': 500, '%': 833, '&': 778,
  "'": 333, '(': 333, ')': 333, '*': 500, '+': 564, ',': 250, '-': 333,
  '.': 250, '/': 278, '0': 500, '1': 500, '2': 500, '3': 500, '4': 500,
  '5': 500, '6': 500, '7': 500, '8': 500, '9': 500, ':': 278, ';': 278,
  '<': 564, '=': 564, '>': 564, '?': 444, '@': 921,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333,
  J: 389, K: 722, L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667,
  S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  '[': 333, '\\': 278, ']': 333, '^': 469, '_': 500, '`': 333,
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278,
  j: 278, k: 500, l: 278, m: 778, n: 500, o: 500, p: 500, q: 500, r: 333,
  s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  '{': 480, '|': 200, '}': 480, '~': 541,
};

const TIMES_ITALIC = {
  ' ': 250, '!': 333, '"': 420, '#': 500, '$': 500, '%': 833, '&': 778,
  "'": 333, '(': 333, ')': 333, '*': 500, '+': 675, ',': 250, '-': 333,
  '.': 250, '/': 278, '0': 500, '1': 500, '2': 500, '3': 500, '4': 500,
  '5': 500, '6': 500, '7': 500, '8': 500, '9': 500, ':': 333, ';': 333,
  '<': 675, '=': 675, '>': 675, '?': 500, '@': 920,
  A: 611, B: 611, C: 667, D: 722, E: 611, F: 611, G: 722, H: 722, I: 333,
  J: 444, K: 667, L: 556, M: 833, N: 667, O: 722, P: 611, Q: 722, R: 611,
  S: 500, T: 556, U: 722, V: 611, W: 833, X: 611, Y: 556, Z: 556,
  '[': 389, '\\': 278, ']': 389, '^': 422, '_': 500, '`': 333,
  a: 500, b: 500, c: 444, d: 500, e: 444, f: 278, g: 500, h: 500, i: 278,
  j: 278, k: 444, l: 278, m: 722, n: 500, o: 500, p: 500, q: 500, r: 389,
  s: 389, t: 278, u: 500, v: 444, w: 667, x: 444, y: 444, z: 389,
  '{': 400, '|': 275, '}': 400, '~': 541,
};

const TIMES_BOLD = {
  ' ': 250, '!': 333, '"': 555, '#': 500, '$': 500, '%': 1000, '&': 833,
  "'": 333, '(': 333, ')': 333, '*': 500, '+': 570, ',': 250, '-': 333,
  '.': 250, '/': 278, '0': 500, '1': 500, '2': 500, '3': 500, '4': 500,
  '5': 500, '6': 500, '7': 500, '8': 500, '9': 500, ':': 333, ';': 333,
  '<': 570, '=': 570, '>': 570, '?': 500, '@': 930,
  A: 722, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 778, I: 389,
  J: 500, K: 778, L: 667, M: 944, N: 722, O: 778, P: 611, Q: 778, R: 722,
  S: 556, T: 667, U: 722, V: 722, W: 1000, X: 722, Y: 722, Z: 667,
  '[': 333, '\\': 278, ']': 333, '^': 581, '_': 500, '`': 333,
  a: 500, b: 556, c: 444, d: 556, e: 444, f: 333, g: 500, h: 556, i: 278,
  j: 333, k: 556, l: 278, m: 833, n: 556, o: 500, p: 556, q: 556, r: 444,
  s: 389, t: 333, u: 556, v: 500, w: 722, x: 500, y: 500, z: 444,
  '{': 394, '|': 220, '}': 394, '~': 520,
};

// Courier: fixed pitch.
const MONO_WIDTH = 600;

function faceOf(style) {
  if (style.tt) return 'mono';
  if (style.b) return style.i ? 'bolditalic' : 'bold';
  if (style.i) return 'italic';
  return 'regular';
}

const TABLES = {
  regular: TIMES_REGULAR,
  italic: TIMES_ITALIC,
  bold: TIMES_BOLD,
  bolditalic: TIMES_BOLD, // close enough for layout; viewer/PDF use real BI face
};

// Widths for characters outside the AFM tables (same across text faces).
const SPECIAL_WIDTHS = {
  ' ': 250, // no-break space (tie)
  ' ': 500, // en space
  ' ': 1000, // em space (after section numbers)
  '•': 350, // bullet
  '…': 889,
  '–': 500,
  '—': 1000,
  '−': 564, // math minus, sized like +/=
};

function charWidth1000(ch, face) {
  if (face === 'mono') return MONO_WIDTH;
  const t = TABLES[face];
  const w = t[ch];
  if (w !== undefined) return w;
  if (SPECIAL_WIDTHS[ch] !== undefined) return SPECIAL_WIDTHS[ch];
  const code = ch.codePointAt(0);
  // CJK and fullwidth ranges: approximately one em.
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  ) {
    return 1000;
  }
  // Greek letters used in math mode: roughly like italic latin.
  if (code >= 0x0370 && code <= 0x03ff) return 510;
  return 500;
}

/** Measure a string in points for the given style {i,b,tt} and size (pt). */
export function measure(text, style, size) {
  const face = faceOf(style || {});
  let w = 0;
  for (const ch of text) w += charWidth1000(ch, face);
  return (w * size) / 1000;
}

/** Interword space width/stretch/shrink in points. */
export function spaceGlue(style, size) {
  const w = measure(' ', style || {}, size);
  return { w, stretch: w * 0.5, shrink: w * 0.33 };
}

/** True if the character should be treated as a CJK box (breakable joins). */
export function isCJK(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

export { faceOf };
