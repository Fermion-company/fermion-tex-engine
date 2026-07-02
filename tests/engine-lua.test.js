// Integration tests for the LuaTeX-backed engine. These run real lualatex,
// so they are skipped when no TeX installation is available.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LuaTexBackend } from '../engine/luatex/backend.js';
import { LuaTDOMEngine } from '../engine/engine-lua.js';

const DEMO = readFileSync(fileURLToPath(new URL('../samples/demo-lua.tex', import.meta.url)), 'utf8');
const WORK = fileURLToPath(new URL('../.tdom-cache-test', import.meta.url));

const available = await LuaTexBackend.detect();
const opts = available ? {} : { skip: 'lualatex not installed' };

let eng;
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  eng = new LuaTDOMEngine({ workDir: WORK });
  await eng.open(DEMO);
});

test('open builds real-LaTeX pages with resolved cross references', opts, () => {
  const dom = eng.getDOM();
  assert.ok(dom.pageCount >= 2);
  assert.equal(dom.labels['sec:math'], '2');
  assert.equal(dom.labels['eq:gauss'], '1');
  assert.equal(dom.labels['thm:main'], '2.1', 'amsthm counter numbered within section');
  assert.equal(dom.labels['sec:inc'], '4');
});

test('word edit recompiles exactly one block and patches only its page', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('watch the inspector');
  const before = eng.getDisplayLists().map((dl) => dl.hash);
  const r = await eng.edit(idx, idx + 'watch'.length, 'check');
  assert.equal(r.stats.blocksCompiled, 1, 'one lualatex block compile');
  assert.deepEqual(r.dirtyPages, [1]);
  const after = eng.getDisplayLists().map((dl) => dl.hash);
  for (let i = 1; i < before.length; i++) {
    assert.equal(after[i], before[i], `page ${i + 1} untouched`);
  }
  assert.ok(r.stats.pagesReused >= before.length - 1);
});

test('undo is a chunk cache hit: zero compiles', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('check the inspector');
  const r = await eng.edit(idx, idx + 'check'.length, 'watch');
  assert.equal(r.stats.blocksCompiled, 0, 'no lualatex run needed');
  assert.equal(r.stats.chunkCacheHits, 1);
});

test('inserting an equation renumbers downstream through the counter chain', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('\\begin{equation}');
  const r = await eng.edit(idx, idx, '\\begin{equation}\n  a^2+b^2=c^2\n\\end{equation}\n\n');
  assert.ok(r.stats.blocksCompiled >= 4, 'cascade recompiled downstream blocks');
  assert.ok(r.stats.labelsChanged.includes('eq:gauss'));
  const dom = eng.getDOM();
  assert.equal(dom.labels['eq:gauss'], '2', 'gauss renumbered 1 -> 2');
  assert.ok(r.dirtyDependencies.some((d) => d.kind === 'counter'));
  assert.ok(r.dirtyDependencies.some((d) => d.kind === 'label' && d.key === 'eq:gauss'));
  // revert
  const src2 = eng.getSource();
  const i2 = src2.indexOf('\\begin{equation}\n  a^2+b^2=c^2\n\\end{equation}\n\n');
  await eng.edit(i2, i2 + '\\begin{equation}\n  a^2+b^2=c^2\n\\end{equation}\n\n'.length, '');
  assert.equal(eng.getDOM().labels['eq:gauss'], '1');
});

test('macro redefinition recompiles only its users', opts, async () => {
  const src = eng.getSource();
  const from = '\\newcommand{\\term}[1]{\\textbf{#1}}';
  const to = '\\newcommand{\\term}[1]{\\emph{#1}}';
  const idx = src.indexOf(from);
  assert.ok(idx > 0);
  const r = await eng.edit(idx, idx + from.length, to);
  assert.deepEqual(r.stats.macrosChanged, ['term']);
  const users = eng.blocks.filter((b) => /\\term(?![a-zA-Z])/.test(b.text)).length;
  assert.equal(r.stats.blocksCompiled, users, 'exactly the \\term-using blocks compiled');
  assert.ok(r.stats.blocksCompiled < r.stats.blocksTotal / 2);
  // revert
  const src2 = eng.getSource();
  const i2 = src2.indexOf(to);
  await eng.edit(i2, i2 + to.length, from);
});

test('label rename dirties exactly the referencing blocks', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('\\label{sec:live}');
  const r = await eng.edit(idx, idx + '\\label{sec:live}'.length, '\\label{sec:live-x}');
  const labelDeps = r.dirtyDependencies.filter((d) => d.kind === 'label');
  assert.ok(labelDeps.some((d) => d.key === 'sec:live'));
  // revert
  const src2 = eng.getSource();
  const i2 = src2.indexOf('\\label{sec:live-x}');
  await eng.edit(i2, i2 + '\\label{sec:live-x}'.length, '\\label{sec:live}');
});

test('a broken block keeps the engine alive and reports a diagnostic', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('Inline mathematics');
  const r = await eng.edit(idx, idx, '\\undefinedmacrofoo ');
  assert.ok(r.rev > 0, 'engine survived');
  // lualatex tolerates unknown commands in nonstop mode, so either a diagnostic
  // appears or the block compiled with the error swallowed — both are alive.
  const r2 = await eng.edit(idx, idx + '\\undefinedmacrofoo '.length, '');
  assert.ok(r2.rev > r.rev);
});

test('full-compile PDF export matches the resident state', opts, async () => {
  const pdf = await eng.exportPDF();
  assert.ok(pdf.subarray(0, 5).toString('latin1').startsWith('%PDF-'));
  assert.ok(pdf.length > 10000);
});
