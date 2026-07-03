// verify-layout.mjs — the referee for "pseudo PDF == real PDF".
//
// Runs the checkpoint engine headlessly on a .tex file, then compiles the
// same file with plain 2-pass lualatex and extracts exact glyph baselines
// from pdftocairo's SVG output. Compares, per page:
//   - line count (distinct baselines)
//   - each baseline's y position and line-start x
//   - real-PDF lines that fall inside an exact-render chunk window count as
//     covered (the chunk pixels ARE the PDF's pixels)
//
// Usage: node tools/verify-layout.mjs <file.tex> [--tol=0.5] [--verbose]
//
// Exit code 0 when every page matches within tolerance; 1 otherwise.

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { pdfRuns } from './pdf-lines.mjs';

const execFileP = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const texFile = args.find((a) => !a.startsWith('--'));
const TOL = Number((args.find((a) => a.startsWith('--tol=')) ?? '--tol=0.1').slice(6));
const VERBOSE = args.includes('--verbose');
if (!texFile) {
  console.error('usage: node tools/verify-layout.mjs <file.tex> [--tol=0.5] [--verbose]');
  process.exit(2);
}

const texPath = path.resolve(texFile);
const texSource = readFileSync(texPath, 'utf8');
const name = path.basename(texPath, '.tex');
const scratch = path.join(os.tmpdir(), `tdom-verify-${name}-${process.pid}`);
mkdirSync(scratch, { recursive: true });

// ---------------------------------------------------------------- engine

async function enginePages() {
  const engine = new CheckpointEngine({
    workDir: path.join(scratch, 'engine'),
    docDir: path.dirname(texPath),
  });
  try {
    await engine.open(texSource);
    // let the background chain AND the exact-render tier settle so the
    // display lists carry their final chunk overlays
    await engine.bgTask.catch(() => {});
    await (engine.renderTask ?? Promise.resolve()).catch(() => {});
    const dls = engine.getDisplayLists();
    const geo = engine.getGeometry();
    return { dls, geo };
  } finally {
    await engine.close();
  }
}

// ---------------------------------------------------------------- truth

async function truthPages() {
  const dir = path.join(scratch, 'truth');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.tex'), texSource);
  const run = () =>
    execFileP('lualatex', ['-interaction=nonstopmode', 'main.tex'], {
      cwd: dir,
      timeout: 180_000,
    }).catch(() => {});
  await run();
  await run();
  const pdf = path.join(dir, 'main.pdf');
  if (!existsSync(pdf)) throw new Error('real lualatex compile failed');
  // exact glyph-run coordinates from the content streams (bp, top-origin)
  return pdfRuns(pdf);
}

/** Cluster glyph runs into lines by baseline (quantized to 0.02bp). */
function toLines(glyphs) {
  const byY = new Map();
  for (const g of glyphs) {
    const key = Math.round(g.y * 50);
    if (!byY.has(key)) byY.set(key, []);
    byY.get(key).push(g);
  }
  const lines = [];
  for (const [key, gs] of byY) {
    lines.push({
      y: key / 50,
      x0: Math.min(...gs.map((g) => g.x)),
      x1: Math.max(...gs.map((g) => g.x)),
      n: gs.reduce((s, g) => s + (g.n ?? 1), 0),
    });
  }
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  return lines;
}

/** Display list -> glyph line starts + chunk windows. */
function dlLines(dl) {
  const glyphs = [];
  const chunks = [];
  for (const cmd of dl.commands) {
    if (cmd.op === 'glyphs') glyphs.push({ x: cmd.x, y: cmd.y });
    else if (cmd.op === 'folio') glyphs.push({ x: cmd.x, y: cmd.y, folio: true });
    else if (cmd.op === 'chunk') chunks.push({ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h });
  }
  return { lines: toLines(glyphs), chunks };
}

function insideChunk(line, chunks, pad = 2.5) {
  return chunks.some(
    (c) =>
      line.y >= c.y - pad &&
      line.y <= c.y + c.h + pad + 3 && // baseline may dip below the window
      line.x0 >= c.x - pad &&
      line.x0 <= c.x + c.w + pad
  );
}

// ---------------------------------------------------------------- compare

function comparePage(pn, engine, truth) {
  const issues = [];
  const eLines = engine ? engine.lines.filter((l) => !l.folio) : [];
  const eFolio = engine ? engine.lines.filter((l) => l.folio) : [];
  const chunks = engine ? engine.chunks : [];
  const tAll = truth ?? [];

  const tUnmatched = [];
  const eUsed = new Set();
  let maxDy = 0;
  let maxDx = 0;
  let matched = 0;
  for (const tl of tAll) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < eLines.length; i++) {
      if (eUsed.has(i)) continue;
      const d = Math.abs(eLines[i].y - tl.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // folio candidates too (the real page number line)
    for (let i = 0; i < eFolio.length; i++) {
      const d = Math.abs(eFolio[i].y - tl.y);
      if (d < bestD) {
        bestD = d;
        best = -1 - i;
      }
    }
    if (best !== null && bestD <= TOL) {
      matched++;
      maxDy = Math.max(maxDy, bestD);
      if (best >= 0) {
        eUsed.add(best);
        const dx = Math.abs(eLines[best].x0 - tl.x0);
        if (dx > maxDx) maxDx = dx;
      }
    } else if (insideChunk(tl, chunks)) {
      matched++; // rendered by the exact tier
    } else {
      tUnmatched.push({ ...tl, nearest: bestD === Infinity ? null : bestD });
    }
  }
  const eUnmatched = eLines.filter((_, i) => !eUsed.has(i));
  // engine lines that sit under a chunk window are the instant approximation
  // behind the exact overlay — invisible, not a divergence
  const eVisible = eUnmatched.filter((l) => !insideChunk(l, chunks));

  if (!engine) issues.push(`page ${pn}: missing in engine output`);
  if (!truth) issues.push(`page ${pn}: engine produced an extra page`);
  for (const l of tUnmatched) {
    issues.push(
      `page ${pn}: PDF line y=${l.y.toFixed(2)} x=${l.x0.toFixed(2)} (${l.n} glyphs) has no ` +
        `engine line within ${TOL}bp` +
        (l.nearest != null && l.nearest < 20 ? ` (nearest dy=${l.nearest.toFixed(2)})` : '')
    );
  }
  for (const l of eVisible) {
    if (matchedNearby(l, tAll)) continue;
    issues.push(
      `page ${pn}: engine line y=${l.y.toFixed(2)} x=${l.x0.toFixed(2)} not present in PDF`
    );
  }
  return { issues, matched, total: tAll.length, maxDy, maxDx };

  function matchedNearby(l, ts) {
    return false;
  }
}

const t0 = Date.now();
let failed = false;
try {
  const [{ dls, geo }, truth] = await Promise.all([enginePages(), truthPages()]);
  console.log(
    `pages: engine=${dls.length} real=${truth.length}` +
      (dls.length !== truth.length ? '  << PAGE COUNT MISMATCH' : '')
  );
  if (dls.length !== truth.length) failed = true;
  const n = Math.max(dls.length, truth.length);
  let totalMatched = 0;
  let totalLines = 0;
  for (let p = 0; p < n; p++) {
    const e = dls[p] ? dlLines(dls[p]) : null;
    const t = truth[p] ? toLines(truth[p]) : null;
    const r = comparePage(p + 1, e, t);
    totalMatched += r.matched;
    totalLines += r.total;
    const ok = r.issues.length === 0;
    if (!ok) failed = true;
    console.log(
      `page ${p + 1}: ${r.matched}/${r.total} lines matched, maxDy=${r.maxDy.toFixed(3)}bp ` +
        `maxDx=${r.maxDx.toFixed(3)}bp ${ok ? 'OK' : 'DIVERGED'}`
    );
    const show = VERBOSE ? r.issues : r.issues.slice(0, 8);
    for (const i of show) console.log('  ' + i);
    if (!VERBOSE && r.issues.length > 8) console.log(`  ... +${r.issues.length - 8} more`);
  }
  console.log(
    `total: ${totalMatched}/${totalLines} lines matched in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
      (failed ? 'DIVERGED' : 'LAYOUT IDENTICAL (within tolerance)')
  );
} catch (err) {
  console.error('verify failed:', err.message);
  failed = true;
} finally {
  if (!args.includes('--keep')) rmSync(scratch, { recursive: true, force: true });
  else console.log('kept scratch dir:', scratch);
}
process.exit(failed ? 1 : 0);
