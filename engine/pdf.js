// PDF writer — serializes display lists into a real PDF file.
//
// This is deliberately downstream of everything: the PDF is just one render
// target of the Display List, produced on demand for export. Uses the five
// non-embedded core fonts matching the engine's metric tables, plus Symbol
// for Greek letters and math relations.
//
// Glyph runs are split into segments per target font (WinAnsi text faces vs
// Symbol), with segment x-offsets computed from the same metrics the layout
// engine used — so the PDF reproduces the engine's positions exactly.

import { PAGE } from './layout.js';
import { measure } from './metrics.js';

const FONTS = {
  regular: { res: 'F1', base: 'Times-Roman' },
  italic: { res: 'F2', base: 'Times-Italic' },
  bold: { res: 'F3', base: 'Times-Bold' },
  bolditalic: { res: 'F4', base: 'Times-BoldItalic' },
  mono: { res: 'F5', base: 'Courier' },
  symbol: { res: 'F6', base: 'Symbol', encoding: null },
};

const FACE_STYLE = {
  regular: { i: 0, b: 0, tt: 0 },
  italic: { i: 1, b: 0, tt: 0 },
  bold: { i: 0, b: 1, tt: 0 },
  bolditalic: { i: 1, b: 1, tt: 0 },
  mono: { i: 0, b: 0, tt: 1 },
};

// Unicode -> WinAnsi byte for characters above 0xFF that WinAnsi still has.
const WINANSI_EXTRA = {
  '•': 0x95, '…': 0x85, '–': 0x96, '—': 0x97,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '†': 0x86, '‡': 0x87, '™': 0x99, '€': 0x80,
};

// Unicode -> Symbol-encoding byte.
const SYMBOL_MAP = {
  'α': 0x61, 'β': 0x62, 'γ': 0x67, 'δ': 0x64, 'ε': 0x65, 'ζ': 0x7a,
  'η': 0x68, 'θ': 0x71, 'ι': 0x69, 'κ': 0x6b, 'λ': 0x6c, 'μ': 0x6d,
  'ν': 0x6e, 'ξ': 0x78, 'π': 0x70, 'ρ': 0x72, 'σ': 0x73, 'τ': 0x74,
  'φ': 0x66, 'χ': 0x63, 'ψ': 0x79, 'ω': 0x77,
  'Γ': 0x47, 'Δ': 0x44, 'Θ': 0x51, 'Λ': 0x4c, 'Ξ': 0x58, 'Π': 0x50,
  'Σ': 0x53, 'Φ': 0x46, 'Ψ': 0x59, 'Ω': 0x57,
  '≤': 0xa3, '≥': 0xb3, '≠': 0xb9, '≈': 0xbb, '≡': 0xba,
  '∞': 0xa5, '→': 0xae, '↦': 0xae, '∈': 0xce, '⊂': 0xcc,
  '∂': 0xb6, '∇': 0xd1, '∫': 0xf2, '−': 0x2d, '√': 0xd6, '·': 0xd7,
};

// Spaces that only advance the pen (drawn as nothing, position from metrics):
// no-break space (tie), en space, em space.
const ADVANCE_ONLY = new Set(['\u00A0', '\u2002', '\u2003']);

export function exportPDF(displayLists) {
  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  const fontRefs = {};
  for (const [key, f] of Object.entries(FONTS)) {
    const enc = key === 'symbol' ? '' : ' /Encoding /WinAnsiEncoding';
    fontRefs[key] = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base}${enc} >>`);
  }
  const resources = addObj(
    `<< /Font << ${Object.entries(FONTS)
      .map(([k, f]) => `/${f.res} ${fontRefs[k]} 0 R`)
      .join(' ')} >> >>`
  );

  const pageObjNums = [];
  const pagesObjNum = objects.length + displayLists.length * 2 + 1; // reserved below

  for (const dl of displayLists) {
    const stream = contentStream(dl);
    const contentNum = addObj(`<< /Length ${byteLen(stream)} >>\nstream\n${stream}\nendstream`);
    const pageNum = addObj(
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources ${resources} 0 R /Contents ${contentNum} 0 R >>`
    );
    pageObjNums.push(pageNum);
  }

  const pagesNum = addObj(
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`
  );
  if (pagesNum !== pagesObjNum) {
    throw new Error('pdf writer: object numbering drifted');
  }
  const catalogNum = addObj(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((body, idx) => {
    offsets.push(byteLen(out));
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = byteLen(out);
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function contentStream(dl) {
  const ops = [];
  for (const cmd of dl.commands) {
    if (cmd.op === 'glyphs') {
      for (const seg of segmentGlyphs(cmd)) {
        const f = FONTS[seg.font] || FONTS.regular;
        const y = PAGE.height - cmd.y;
        ops.push(
          `BT /${f.res} ${num(cmd.size)} Tf 1 0 0 1 ${num(seg.x)} ${num(y)} Tm (${seg.bytes}) Tj ET`
        );
      }
    } else if (cmd.op === 'rule') {
      const y = PAGE.height - cmd.y - cmd.h;
      ops.push(`${num(cmd.x)} ${num(y)} ${num(cmd.w)} ${num(cmd.h)} re f`);
    }
  }
  return ops.join('\n');
}

/**
 * Split one glyph command into font segments with engine-metric x offsets.
 * Yields { font, x, bytes } where bytes is a PDF-escaped latin1 string.
 */
function* segmentGlyphs(cmd) {
  const style = FACE_STYLE[cmd.font] || FACE_STYLE.regular;
  let x = cmd.x;
  let segFont = null;
  let segX = 0;
  let segBytes = '';

  const flush = () => {
    if (segBytes) yield0.push({ font: segFont, x: segX, bytes: segBytes });
    segBytes = '';
  };
  const yield0 = [];

  for (const ch of cmd.text) {
    const w = measure(ch, style, cmd.size);
    if (ADVANCE_ONLY.has(ch)) {
      flush();
      segFont = null;
      x += w;
      continue;
    }
    let font;
    let byte;
    const code = ch.codePointAt(0);
    if (code < 0x100) {
      font = cmd.font;
      byte = code;
    } else if (WINANSI_EXTRA[ch] !== undefined) {
      font = cmd.font;
      byte = WINANSI_EXTRA[ch];
    } else if (SYMBOL_MAP[ch] !== undefined) {
      font = 'symbol';
      byte = SYMBOL_MAP[ch];
    } else {
      font = cmd.font;
      byte = 0x3f; // '?': outside every core encoding (e.g. CJK)
    }
    if (font !== segFont) {
      flush();
      segFont = font;
      segX = x;
    }
    segBytes += escapeByte(byte);
    x += w;
  }
  flush();
  yield* yield0;
}

function escapeByte(code) {
  if (code === 0x28 || code === 0x29 || code === 0x5c) return '\\' + String.fromCharCode(code);
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  return '\\' + code.toString(8).padStart(3, '0');
}

function num(v) {
  return Math.round(v * 100) / 100;
}

function byteLen(s) {
  return Buffer.byteLength(s, 'latin1');
}
