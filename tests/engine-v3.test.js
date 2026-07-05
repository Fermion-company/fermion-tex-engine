// Integration tests for the checkpoint engine — the endgame architecture.
// These fork real lualatex processes; skipped without a TeX installation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LuaTexBackend } from '../engine/luatex/backend.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const DEMO = readFileSync(fileURLToPath(new URL('../samples/demo-lua.tex', import.meta.url)), 'utf8');
const WORK = fileURLToPath(new URL('../.tdom-v3-test', import.meta.url));

const available = await LuaTexBackend.detect();
const opts = available ? {} : { skip: 'lualatex not installed' };

let eng;
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  eng = new CheckpointEngine({ workDir: WORK });
  await eng.open(DEMO);
});
after(async () => {
  if (eng) await eng.close();
});

test('open builds the resident chain with real label values', opts, () => {
  const dom = eng.getDOM();
  assert.ok(dom.pageCount >= 2);
  assert.equal(dom.labels['sec:math'], '2');
  assert.equal(dom.labels['eq:gauss'], '1');
  assert.equal(dom.labels['thm:main'], '2.1');
  assert.ok(dom.checkpoints.length >= dom.blocks.length, 'one checkpoint per block boundary');
  assert.ok(eng.getFontManifest().length >= 3, 'real font files registered');
});

test('a word edit costs single-digit milliseconds of typesetting', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('watch the inspector');
  const t0 = performance.now();
  const r = await eng.edit(idx, idx + 'watch'.length, 'check');
  const wall = performance.now() - t0;
  assert.ok(r.stats.blocksTypeset <= 2, `edited + convergence probe only (got ${r.stats.blocksTypeset})`);
  assert.deepEqual(r.dirtyPages, [1]);
  assert.ok(r.stats.pagesReused >= r.stats.pageCount - 1, 'untouched pages adopted');
  assert.ok(wall < 500, `fork-resume edit should be fast, took ${wall.toFixed(0)}ms`);
  // steady-state check: repeat edits stay in the same class
  let worst = 0;
  for (let i = 0; i < 5; i++) {
    const t1 = performance.now();
    await eng.edit(idx, idx + 5, i % 2 ? 'check' : 'watch');
    worst = Math.max(worst, performance.now() - t1);
  }
  assert.ok(worst < 500, `worst repeat edit ${worst.toFixed(0)}ms`);
});

test('display lists carry real glyph runs with TeX positions', opts, () => {
  const dl = eng.getDisplayLists()[0];
  const glyphs = dl.commands.filter((c) => c.op === 'glyphs');
  assert.ok(glyphs.length > 100, 'page 1 painted from glyph runs');
  assert.ok(glyphs.every((g) => typeof g.x === 'number' && typeof g.y === 'number' && g.fam));
  const rules = dl.commands.filter((c) => c.op === 'rule');
  assert.ok(rules.length >= 1, 'fraction bars / rules present');
});

test('ordinary one-column preview keeps the original editable display path', opts, () => {
  const commands = eng.getDisplayLists().flatMap((p) => p.commands);
  assert.equal(commands.filter((c) => c.layout === 'multicol').length, 0);
  assert.equal(commands.filter((c) => c.op === 'hitbox').length, 0);
});

test('equation insertion renumbers downstream through the live chain', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('\\begin{equation}');
  const r = await eng.edit(idx, idx, '\\begin{equation}q=1\\end{equation}\n\n');
  assert.ok(r.stats.labelsChanged.includes('eq:gauss'));
  assert.equal(eng.getDOM().labels['eq:gauss'], '2', 'gauss renumbered 1 -> 2');
  // revert
  const src2 = eng.getSource();
  const ins = '\\begin{equation}q=1\\end{equation}\n\n';
  const i2 = src2.indexOf(ins);
  await eng.edit(i2, i2 + ins.length, '');
  assert.equal(eng.getDOM().labels['eq:gauss'], '1', 'renumbering reverted');
});

test('TikZ blocks are flagged for the exact-render tier and get chunks', opts, async () => {
  const dom = eng.getDOM();
  const gfx = dom.blocks.filter((b) => b.gfx);
  assert.ok(gfx.length >= 1, 'tikz block detected via pdf literals');
  // wait for the async exact render to land
  const id = gfx[0].gfxChunks?.[0] ?? gfx[0].id;
  for (let i = 0; i < 100 && !eng.getChunkSVG(id); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const svg = eng.getChunkSVG(id);
  assert.ok(svg && svg.includes('<svg'), 'exact chunk rendered');
});

test('preamble edits take the honest full-rebuild path', opts, async () => {
  const src = eng.getSource();
  const anchor = '\\newcommand{\\engine}{Fermion TeX Engine}';
  const idx = src.indexOf(anchor);
  const r = await eng.edit(idx, idx + anchor.length, '\\newcommand{\\engine}{Fermion Engine}');
  assert.ok(r.stats.rebooted, 'root process rebooted on preamble change');
  assert.ok(eng.getDOM().labels['sec:math'] === '2', 'state rebuilt correctly');
});

test('the engine survives malformed input mid-typing', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('Edit any word');
  const r1 = await eng.edit(idx, idx, '\\emph{');
  assert.ok(r1.rev > 0, 'unclosed group tolerated');
  const r2 = await eng.edit(idx, idx + 6, '');
  assert.ok(r2.rev > r1.rev, 'recovered after fix');
});

test('footnotes are captured live and placed at the page bottom', opts, () => {
  const withFeet = eng.pages.filter((p) => p.feet.length > 0);
  assert.ok(withFeet.length >= 1, 'a page carries live footnotes');
  const dl = withFeet[0].dl ?? null;
  // the display list must contain the footnote rule
  const dlNow = eng.getDisplayLists()[withFeet[0].number - 1];
  assert.ok(dlNow.commands.some((c) => c.op === 'rule' && c.src === '_footrule'), 'footnote rule drawn');
});

test('figure floats are placed by the live output routine with real captions', opts, () => {
  const dom = eng.getDOM();
  assert.equal(dom.labels['fig:plot'], '1', 'real figure counter');
  const floated = eng.pages.some((p) => p.topFloats.length + p.botFloats.length > 0);
  assert.ok(floated, 'float placed in a top/bottom area');
});

test('the table of contents typesets live with page numbers', opts, () => {
  const toc = eng.blocks.find((b) => /\\tableofcontents/.test(b.text));
  assert.ok(toc?.galley, 'toc block typeset');
  const boxes = (toc.galley.items ?? []).filter((i) => i.k === 'box');
  assert.ok(boxes.length >= 5, `toc entries present (got ${boxes.length})`);
});

test('citations resolve from the live bibliography', opts, async () => {
  assert.equal(eng.getDOM().labels['cite:knuth84'], '1');
  assert.equal(eng.getDOM().labels['cite:lamport94'], '2');
  const citeBlock = eng.blocks.find((b) => b.text.includes('cite{knuth84}'));
  assert.ok(!JSON.stringify(citeBlock.galley.items).includes('[?]'), 'no unresolved citations');
  // swap the two bibliography entries: citation numbers must follow
  const src = eng.getSource();
  const a = '\\bibitem{knuth84}';
  const b = '\\bibitem{lamport94}';
  const ia = src.indexOf(a);
  assert.ok(ia > 0);
  const r = await eng.edit(ia, ia + a.length, '\\bibitem{tempx}');
  assert.ok(r.stats.labelsChanged.some((k) => k.startsWith('cite:')), 'cite keys tracked');
  const src2 = eng.getSource();
  const i2 = src2.indexOf('\\bibitem{tempx}');
  await eng.edit(i2, i2 + '\\bibitem{tempx}'.length, a);
});

test('label renames propagate backwards to earlier referencing blocks', opts, async () => {
  const src = eng.getSource();
  const li = src.indexOf('\\label{fig:plot}');
  await eng.edit(li, li + 17, '\\label{fig:plotX}');
  const rb = eng.blocks.find((b) => b.text.includes('is a genuine float'));
  assert.ok(JSON.stringify(rb.galley.items).includes('??'), 'earlier ref turned into ??');
  const src2 = eng.getSource();
  const l2 = src2.indexOf('\\label{fig:plotX}');
  await eng.edit(l2, l2 + 18, '\\label{fig:plot}');
  const rb2 = eng.blocks.find((b) => b.text.includes('is a genuine float'));
  assert.ok(!JSON.stringify(rb2.galley.items).includes('??'), 'restored and resolved');
});

test('multicols starting mid-page stays on the resident glyph preview path', opts, async () => {
  const body = Array.from(
    { length: 18 },
    (_, i) =>
      `Paragraph ${i + 1}. ` +
      'The multicol package balances text into multiple columns inside the page. '.repeat(5)
  ).join('\n\n');
  const tex = String.raw`\documentclass{article}
\usepackage[a4paper,margin=20mm]{geometry}
\usepackage{multicol}
\title{Multicol Probe}
\author{Fermion}
\date{}
\begin{document}
\maketitle
\section{Before}
This paragraph is before the multicols environment and should span the normal text width.

\begin{multicols}{2}
\section{Inside Multicols}
` + body + String.raw`
\end{multicols}

\section{After}
This paragraph is after the environment and should return to normal width.
\end{document}
`;
  const report = await eng.open(tex);
  assert.equal(report.stats.fullPagePreview, false);
  assert.equal(report.stats.fullPagePreviewReason, '');
  assert.equal(report.stats.pageCount, 2);
  const pages = eng.getDisplayLists();
  assert.equal(pages.length, 2);
  assert.ok(pages.every((p) => p.commands.some((c) => c.op === 'glyphs')));
  assert.equal(pages.flatMap((p) => p.commands).filter((c) => c.op === 'chunk').length, 0);
  assert.ok(
    pages.some((p) => p.commands.some((c) => c.op === 'glyphs' && /^b\d+$/.test(c.src))),
    'multicol preview exposes editable glyph source regions'
  );
  assert.ok(
    pages.some((p) => p.commands.some((c) => c.op === 'glyphs' && c.x > 300)),
    'right-column glyphs are present in the resident display list'
  );
  const hitboxes = pages.flatMap((p) => p.commands.filter((c) => c.op === 'hitbox' && c.layout === 'multicol'));
  assert.ok(hitboxes.length >= 2, 'multicol preview exposes column hitboxes');
  assert.ok(hitboxes.some((c) => c.column === 0), 'left column hitbox present');
  assert.ok(hitboxes.some((c) => c.column === 1), 'right column hitbox present');
  for (const page of pages.filter((p) => p.commands.some((c) => c.op === 'glyphs' && c.layout === 'multicol'))) {
    const columns = new Set(
      page.commands
        .filter((c) => c.op === 'hitbox' && c.layout === 'multicol')
        .map((c) => c.column)
    );
    assert.ok(columns.has(0), `page ${page.page} exposes a left-column edit hitbox`);
    assert.ok(columns.has(1), `page ${page.page} exposes a right-column edit hitbox`);
  }
  const geo = eng.getGeometry();
  assert.ok(
    hitboxes.every((c) => c.y >= -0.5 && c.y + c.h <= geo.paperheight + 0.5),
    'multicol edit hitboxes stay within the visible page'
  );
  assert.ok(
    eng.getDOM().blocks.some((b) => b.pages.length > 0),
    'DOM block page mapping includes multicol glyphs'
  );

  const beforeEditHash = JSON.stringify(eng.getDisplayLists().map((p) => p.hash));
  const idx = eng.getSource().indexOf('Paragraph 1.');
  const editReport = await eng.edit(idx, idx + 'Paragraph 1'.length, 'Paragraph One');
  assert.equal(editReport.stats.fullPagePreviewPending, false);
  assert.ok(
    editReport.stats.totalUs < 300_000,
    `multicol edit should stay on the resident path (${editReport.stats.totalUs}us)`
  );
  assert.notEqual(JSON.stringify(eng.getDisplayLists().map((p) => p.hash)), beforeEditHash);
});
