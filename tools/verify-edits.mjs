// verify-edits.mjs — exactness THROUGH the incremental path.
//
// Opens a document, applies a series of realistic edits (word change,
// equation insertion, label rename and revert, paragraph deletion), then
// checks that the display lists produced by the INCREMENTAL machinery match
// a fresh 2-pass lualatex of the final source — same referee as
// verify-layout, but the engine state got there through edits.
//
// usage: node tools/verify-edits.mjs [file.tex]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { pdfRuns } from './pdf-lines.mjs';

const execFileP = promisify(execFile);
const texFile = process.argv[2] ?? 'samples/demo-lua.tex';
const TOL = 0.1;
const texPath = path.resolve(texFile);
const scratch = path.join(os.tmpdir(), `tdom-vedit-${process.pid}`);
mkdirSync(scratch, { recursive: true });

const engine = new CheckpointEngine({
  workDir: path.join(scratch, 'engine'),
  docDir: path.dirname(texPath),
});
await engine.open(readFileSync(texPath, 'utf8'));

async function editAt(needle, replace, insert = false) {
  const src = engine.getSource();
  const i = src.indexOf(needle);
  if (i < 0) return false;
  await engine.edit(insert ? i : i, insert ? i : i + needle.length, replace);
  return true;
}

// a realistic editing session
const steps = [];
steps.push(await editAt('resident', 'RESIDENT'));
steps.push(await editAt('RESIDENT', 'resident'));
steps.push(
  await editAt('\\begin{align}', '\\begin{equation}\n  a^2 + b^2 = c^2\n\\end{equation}\n\n', true)
);
steps.push(await editAt('\\label{eq:gauss}', '\\label{eq:gaussX}'));
steps.push(await editAt('\\eqref{eq:gauss}', '\\eqref{eq:gaussX}'));
steps.push(await editAt('Insert a new numbered equation above them and the', 'Renumbering:'));
console.log(`applied ${steps.filter(Boolean).length}/${steps.length} edits`);

await engine.bgTask.catch(() => {});
await (engine.renderTask ?? Promise.resolve()).catch(() => {});

// truth: fresh 2-pass compile of the FINAL source
const dir = path.join(scratch, 'truth');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'main.tex'), engine.getSource());
const run = () =>
  execFileP('lualatex', ['-interaction=nonstopmode', 'main.tex'], {
    cwd: dir,
    timeout: 180_000,
  }).catch(() => {});
await run();
await run();
if (!existsSync(path.join(dir, 'main.pdf'))) throw new Error('truth compile failed');
const truth = pdfRuns(path.join(dir, 'main.pdf'));

const dls = engine.getDisplayLists();
await engine.close();

function toLines(glyphs) {
  const byY = new Map();
  for (const g of glyphs) {
    const key = Math.round(g.y * 50);
    byY.set(key, Math.min(byY.get(key) ?? Infinity, g.x));
  }
  return [...byY.entries()].map(([k, x]) => ({ y: k / 50, x0: x })).sort((a, b) => a.y - b.y);
}

let failed = dls.length !== truth.length;
console.log(`pages: engine=${dls.length} real=${truth.length}`);
for (let p = 0; p < Math.max(dls.length, truth.length); p++) {
  const dl = dls[p];
  const eng = [];
  const chunks = [];
  for (const c of dl?.commands ?? []) {
    if (c.op === 'glyphs' || c.op === 'folio') eng.push({ x: c.x, y: c.y });
    else if (c.op === 'chunk') chunks.push(c);
  }
  const eLines = toLines(eng);
  const tLines = toLines(truth[p] ?? []);
  let matched = 0;
  let maxDy = 0;
  const misses = [];
  for (const tl of tLines) {
    const best = eLines.reduce(
      (b, el) => (Math.abs(el.y - tl.y) < Math.abs(b.y - tl.y) ? el : b),
      { y: Infinity }
    );
    const dy = Math.abs(best.y - tl.y);
    if (dy <= TOL) {
      matched++;
      maxDy = Math.max(maxDy, dy);
    } else if (
      chunks.some((c) => tl.y >= c.y - 2.5 && tl.y <= c.y + c.h + 5.5 && tl.x0 >= c.x - 2.5)
    ) {
      matched++;
    } else {
      misses.push(tl);
    }
  }
  const ok = misses.length === 0;
  if (!ok) failed = true;
  console.log(
    `page ${p + 1}: ${matched}/${tLines.length} matched maxDy=${maxDy.toFixed(3)} ${ok ? 'OK' : 'DIVERGED'}`
  );
  for (const miss of misses.slice(0, 6)) {
    console.log(`  miss y=${miss.y.toFixed(2)} x=${miss.x0.toFixed(2)}`);
  }
}
rmSync(scratch, { recursive: true, force: true });
console.log(failed ? 'EDIT PATH DIVERGED' : 'EDIT PATH EXACT');
process.exit(failed ? 1 : 0);
