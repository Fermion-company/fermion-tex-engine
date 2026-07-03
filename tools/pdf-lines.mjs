// pdf-lines.mjs — exact glyph-run positions straight from a PDF's content
// streams (no rasterizer, no cairo: pdftocairo -svg distorts coordinates by
// ~0.1%, which is far above our tolerance). LuaTeX emits one
// `1 0 0 1 x y Tm [..]TJ` per positioned run, so parsing is exact.
//
// Returns per page: [{x, y, n}] runs with y measured from the page top in bp.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

export function pdfRuns(pdfPath) {
  const qdf = pdfPath + '.qdf';
  execFileSync('qpdf', [
    '--qdf',
    '--object-streams=disable',
    '--stream-data=uncompress',
    pdfPath,
    qdf,
  ]);
  const raw = readFileSync(qdf, 'latin1');
  rmSync(qdf, { force: true });

  // objects: "N 0 obj ... endobj"
  const objects = new Map();
  const objRe = /(\d+)\s+0\s+obj\b/g;
  let m;
  const marks = [];
  while ((m = objRe.exec(raw))) marks.push({ num: Number(m[1]), at: m.index, bodyAt: objRe.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const end = raw.indexOf('endobj', marks[i].bodyAt);
    objects.set(marks[i].num, raw.slice(marks[i].bodyAt, end < 0 ? undefined : end));
  }

  // page objects in document order (qdf writes them in page order)
  const pages = [];
  for (const { num } of marks) {
    const body = objects.get(num);
    if (!body || !/\/Type\s*\/Page[^s]/.test(body)) continue;
    const mb = body.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
    const H = mb ? Number(mb[4]) - Number(mb[2]) : 841.89;
    const contents = [];
    const cm = body.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const ca = body.match(/\/Contents\s*\[([^\]]*)\]/);
    if (cm) contents.push(Number(cm[1]));
    else if (ca) for (const r of ca[1].matchAll(/(\d+)\s+0\s+R/g)) contents.push(Number(r[1]));
    pages.push({ H, contents });
  }

  return pages.map((p) => {
    let ops = '';
    for (const num of p.contents) {
      const body = objects.get(num) ?? '';
      const sm = body.match(/stream\r?\n([\s\S]*?)endstream/);
      if (sm) ops += sm[1] + '\n';
    }
    return parseOps(ops, p.H);
  });
}

function parseOps(ops, pageH) {
  const runs = [];
  // text matrix translation (LuaTeX uses translations; a/d scale for fake
  // sizes doesn't move the origin) + Td line moves as fallback
  let tmX = 0;
  let tmY = 0;
  let lineX = 0;
  let lineY = 0;
  const tokenRe = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+Td|(-?[\d.]+)\s+(-?[\d.]+)\s+TD|\bT\*/g;
  let m;
  while ((m = tokenRe.exec(ops))) {
    if (m[3] !== undefined) {
      tmX = Number(m[7]);
      tmY = Number(m[8]);
      lineX = tmX;
      lineY = tmY;
    } else if (m[9] !== undefined) {
      lineX += Number(m[9]);
      lineY += Number(m[10]);
      tmX = lineX;
      tmY = lineY;
    } else if (m[11] !== undefined) {
      lineX += Number(m[11]);
      lineY += Number(m[12]);
      tmX = lineX;
      tmY = lineY;
    } else if (m[0] === 'T*') {
      tmX = lineX;
      tmY = lineY;
    } else if (m[1] !== undefined) {
      // TJ array: count glyphs across hex/literal strings
      let n = 0;
      for (const h of m[1].matchAll(/<([0-9a-fA-F\s]*)>/g)) {
        n += Math.floor(h[1].replace(/\s/g, '').length / 4);
      }
      for (const l of m[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) n += l[1].length;
      if (n > 0) runs.push({ x: tmX, y: pageH - tmY, n });
    } else if (m[2] !== undefined) {
      runs.push({ x: tmX, y: pageH - tmY, n: m[2].length });
    }
  }
  return runs;
}
