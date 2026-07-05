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
const LIVE_WORK = fileURLToPath(new URL('../.tdom-v3-live-test', import.meta.url));

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

test('multicols variants handle three or more columns', opts, async () => {
  const makeTex = (env, cols, paragraphs) => {
    const body = Array.from(
      { length: paragraphs },
      (_, i) =>
        `Paragraph ${i + 1}. ` +
        'This text exercises multi column layout with enough material to wrap across columns and pages. '.repeat(3)
    ).join('\n\n');
    return String.raw`\documentclass{article}
\usepackage[a4paper,margin=18mm]{geometry}
\usepackage{multicol}
\begin{document}
A normal paragraph before the multi-column region.

\begin{` + env + String.raw`}{` + cols + String.raw`}
\section{Column Probe}
` + body + String.raw`
\end{` + env + String.raw`}

A normal paragraph after the multi-column region.
\end{document}`;
  };

  // Balancing multicols with 4+ columns takes the exact full-page fallback
  // (the resident output routine is unstable there); multicols* and low column
  // counts stay on the resident glyph path. EITHER way, every column must
  // expose a layout:'multicol' edit hitbox.
  const specs = [
    { env: 'multicols', cols: 3, paragraphs: 32, exact: false },
    { env: 'multicols', cols: 4, paragraphs: 38, exact: true },
    { env: 'multicols', cols: 5, paragraphs: 44, exact: true },
    { env: 'multicols*', cols: 3, paragraphs: 32, exact: false },
    { env: 'multicols*', cols: 4, paragraphs: 38, exact: false },
  ];
  for (const spec of specs) {
    const report = await eng.open(makeTex(spec.env, spec.cols, spec.paragraphs));
    assert.equal(report.stats.fullPagePreview, spec.exact, `${spec.env} ${spec.cols} preview path`);
    assert.equal(
      report.stats.fullPagePreviewReason,
      spec.exact ? 'multicols environment with 4+ columns' : ''
    );
    const geo = eng.getGeometry();
    const pages = eng.getDisplayLists();
    assert.ok(pages.length >= 2, `${spec.env} ${spec.cols} paginates`);
    const commands = pages.flatMap((p) => p.commands);
    const hitboxes = commands.filter((c) => c.op === 'hitbox');
    assert.ok(hitboxes.length > 0, `${spec.env} ${spec.cols} exposes edit hitboxes`);
    assert.ok(
      hitboxes.every((c) => c.y >= -0.5 && c.y + c.h <= geo.paperheight + 0.5),
      `${spec.env} ${spec.cols} hitboxes stay within the visible page`
    );
    // both the resident path and the exact full-page fallback expose per-column
    // multicol hitboxes so every column is editable in the preview
    const columnHitboxes = commands.filter((c) => c.op === 'hitbox' && c.layout === 'multicol');
    assert.ok(columnHitboxes.some((c) => c.column === spec.cols - 1), `${spec.env} ${spec.cols} last column hitbox`);
    if (spec.exact) {
      assert.ok(commands.some((c) => c.op === 'chunk'), `${spec.env} ${spec.cols} exact page chunk`);
    } else {
      assert.ok(commands.some((c) => c.op === 'glyphs' && c.layout === 'multicol'), `${spec.env} ${spec.cols} resident glyphs`);
    }
  }
});

test('native page-layout PoC observes multicols from normal TeX shipouts', opts, async () => {
  const specs = [];
  for (const env of ['multicols', 'multicols*']) {
    for (let cols = 2; cols <= 6; cols++) specs.push({ env, cols });
  }
  const envs = specs.map(({ env, cols }) => {
    const label = `${env}-${cols}`;
    const body = Array.from(
      { length: 8 },
      (_, i) =>
        `Column ${label} paragraph ${i + 1}. ` +
        'Native page layout proof of concept keeps the multicol package on the ordinary TeX output path. '.repeat(2)
    ).join('\n\n');
    return String.raw`\begin{` + env + String.raw`}{` + cols + String.raw`}
` + body + String.raw`
\end{` + env + String.raw`}`;
  }).join('\n\n');
  const tex = String.raw`\documentclass{article}
\usepackage[a4paper,margin=18mm]{geometry}
\usepackage{multicol}
\begin{document}
Intro text before the normal-TeX page layout proof of concept.

` + envs + String.raw`

Closing text after the multicol probes.
\end{document}`;

  await eng.open(tex);
  const poc = await eng.buildNativePageLayoutPoc({ jobTag: 'multicol-normal-tex' });

  assert.equal(poc.normalTex, true);
  assert.equal(poc.mode, 'normal-tex-pre-shipout-callback');
  assert.ok(poc.synctex, 'SyncTeX sidecar is generated for source/page correlation');
  assert.ok(poc.pageCount >= 1, 'normal TeX shipped pages');
  assert.ok(poc.stats.glyphs > 0, 'Lua callback extracted glyph positions');
  assert.ok(
    poc.pages.every((p, i) => p.state?.shipoutIndex === i + 1),
    'each page carries the TeX state observed at shipout'
  );
  assert.ok(
    poc.pages.every((p) => (p.state?.processSnapshot?.pid ?? 0) > 0),
    'each normal-TeX page boundary gets a fork snapshot'
  );

  const multicolBlocks = poc.blocks.filter((b) =>
    /\\begin\{multicols\*?\}/.test(tex.slice(b.start, b.end))
  );
  assert.equal(multicolBlocks.length, specs.length, 'all 2-6 column variants are block-attributed');
  const glyphBlocks = new Set(
    poc.pages.flatMap((p) => (p.glyphs ?? []).filter((g) => g.block).map((g) => g.block))
  );
  for (const block of multicolBlocks) {
    assert.ok(block.pages.length > 0, `${tex.slice(block.start, block.end).match(/\\begin\{[^}]+\}\{\d+\}/)?.[0]} has page coverage`);
    assert.ok(glyphBlocks.has(block.id), `${block.id} has Lua-extracted glyph positions`);
  }
});

test('full-page preview detection sees later four-column multicols blocks', opts, async () => {
  const paragraphs = Array.from(
    { length: 24 },
    (_, i) =>
      `Paragraph ${i + 1}. ` +
      'This text keeps a later four-column multicols block large enough to exercise the exact preview fallback. '.repeat(2)
  ).join('\n\n');
  const report = await eng.open(String.raw`\documentclass{article}
\usepackage[a4paper,margin=18mm]{geometry}
\usepackage{multicol}
\begin{document}
\begin{multicols}{3}
This earlier three-column block should not hide a later four-column block from the detector.
\end{multicols}

\begin{multicols}{4}
${paragraphs}
\end{multicols}
\end{document}`);

  assert.equal(report.stats.fullPagePreview, true);
  assert.equal(report.stats.fullPagePreviewReason, 'multicols environment with 4+ columns');
  assert.ok(Array.isArray(report.dirtySourceNodes));
  assert.ok(Array.isArray(report.dirtyDependencies));
  const commands = eng.getDisplayLists().flatMap((p) => p.commands);
  assert.ok(commands.some((c) => c.op === 'chunk'), 'exact page chunks present');
  // the exact fallback still exposes per-column edit hitboxes
  const columnHitboxes = commands.filter((c) => c.op === 'hitbox' && c.layout === 'multicol');
  assert.ok(columnHitboxes.some((c) => c.column === 3), 'exact fallback exposes 4th column hitbox');
});

test('full-page exact preview keeps native column hitboxes tight', opts, async () => {
  const paracolReport = await eng.open(String.raw`\documentclass{article}
\usepackage[a4paper,margin=18mm]{geometry}
\usepackage{paracol}
\begin{document}
\section{Before}
This paragraph is outside the parallel region.

\begin{paracol}{2}
\section{Left Track}
The left column starts here. Native column hitboxes should stay in the left column instead of wrapping the whole page.

The left side continues with another paragraph so the outline has real height.

\switchcolumn
\section{Right Track}
The right column starts here. Its edit hitbox should be separate from the left column.

More right-column material follows to make a visible parallel track.
\end{paracol}

\section{After}
This paragraph returns to normal width after the paracol environment.

\clearpage
\section{Tail}
The tail page should not inherit the after-paracol edit hitbox.
\end{document}`);
  assert.equal(paracolReport.stats.fullPagePreview, true);
  assert.equal(paracolReport.stats.fullPagePreviewReason, 'paracol environment');
  const beforeHeading = eng.blocks.find((b) => /\\section\{Before\}/.test(b.text));
  assert.ok(beforeHeading, 'standalone heading block found in full-page exact document');
  assert.equal(
    eng.getDOM().blocks.find((b) => b.id === beforeHeading.id)?.type,
    'heading',
    'full-page exact DOM still exposes heading blocks'
  );
  const paracolGeo = eng.getGeometry();
  const paracolCommands = eng.getDisplayLists().flatMap((p) => p.commands);
  assert.ok(paracolCommands.some((c) => c.op === 'chunk'), 'paracol renders as exact full-page chunks');
  const paracolHitboxes = paracolCommands.filter((c) => c.op === 'hitbox' && c.layout === 'paracol');
  assert.ok(paracolHitboxes.some((c) => c.column === 0), 'paracol left-column hitbox present');
  assert.ok(paracolHitboxes.some((c) => c.column === 1), 'paracol right-column hitbox present');
  assert.ok(
    paracolHitboxes.every((c) => c.w < paracolGeo.textwidth * 0.65),
    'paracol hitboxes stay column-sized rather than page-wide'
  );
  const afterBlock = eng.blocks.find((b) => /returns to normal width after the paracol environment/.test(b.text));
  assert.ok(afterBlock, 'after-paracol block found');
  const afterHitboxes = eng.getDisplayLists().flatMap((p) =>
    p.commands
      .filter((c) => c.op === 'hitbox' && c.src === afterBlock.id)
      .map((c) => ({ ...c, page: p.page }))
  );
  assert.ok(afterHitboxes.length > 0, 'after-paracol block has an editable hitbox');
  assert.ok(
    afterHitboxes.every((c) => c.y > Math.min(...paracolHitboxes.map((h) => h.y))),
    'after-paracol hitboxes do not leak upward into the paracol column region'
  );
  assert.ok(
    afterHitboxes.every((c) => c.page === 1),
    'after-paracol hitboxes do not leak past the following clearpage'
  );

  const twocolumnReport = await eng.open(String.raw`\documentclass[twocolumn]{article}
\usepackage[a4paper,margin=18mm]{geometry}
\title{Two Column Smoke Test}
\author{Fermion}
\date{}
\begin{document}
\maketitle
\section{Opening}
This is a standard LaTeX two-column document. It uses the class option rather than a custom editor widget.

This second paragraph keeps flowing in the first column and should still produce a readable exact preview.

\section{Middle}
Column material continues here with enough text to make the two-column output visible. TeX owns the page layout.

More material follows in the active column. The preview should not report an error.

\onecolumn
\section{After Columns}
The document has returned to ordinary one-column width after the twocolumn check.
\end{document}`);
  assert.equal(twocolumnReport.stats.fullPagePreview, true);
  assert.equal(twocolumnReport.stats.fullPagePreviewReason, 'twocolumn class option');
  const twocolumnGeo = eng.getGeometry();
  const twocolumnCommands = eng.getDisplayLists().flatMap((p) => p.commands);
  assert.ok(twocolumnCommands.some((c) => c.op === 'chunk'), 'twocolumn renders as exact full-page chunks');
  const twocolumnHitboxes = twocolumnCommands.filter((c) => c.op === 'hitbox');
  assert.ok(twocolumnHitboxes.length > 0, 'twocolumn exposes editable hitboxes');
  assert.ok(
    twocolumnHitboxes.every((c) => c.w < twocolumnGeo.paperwidth * 0.75),
    'twocolumn hitboxes do not expand to the full page width'
  );
  const afterColumnBlock = eng.blocks.find((b) => /returned to ordinary one-column width/.test(b.text));
  assert.ok(afterColumnBlock, 'after-twocolumn block found');
  const afterColumnHitboxes = eng.getDisplayLists().flatMap((p) =>
    p.commands
      .filter((c) => c.op === 'hitbox' && c.src === afterColumnBlock.id)
      .map((c) => ({ ...c, page: p.page }))
  );
  assert.ok(afterColumnHitboxes.length > 0, 'after-twocolumn block has an editable hitbox');
  assert.ok(
    afterColumnHitboxes.every((c) => c.page > 1),
    'after-twocolumn hitboxes do not leak back into the native two-column page'
  );
  const afterHeadingBlock = eng.blocks.find((b) => /\\section\{After Columns\}/.test(b.text));
  assert.ok(afterHeadingBlock, 'after-twocolumn heading block found');
  const afterHeadingHitboxes = eng.getDisplayLists().flatMap((p) =>
    p.commands
      .filter((c) => c.op === 'hitbox' && c.src === afterHeadingBlock.id)
      .map((c) => ({ ...c, page: p.page }))
  );
  assert.ok(
    afterHeadingHitboxes.every((c) => c.page > 1),
    'short twocolumn headings without unique terms do not create stale hitboxes on earlier pages'
  );
});

test('full-page exact documents still patch a live preview on edit', opts, async () => {
  rmSync(LIVE_WORK, { recursive: true, force: true });
  const liveEng = new CheckpointEngine({ workDir: LIVE_WORK });
  try {
    await liveEng.open(String.raw`\documentclass{article}
\usepackage[a4paper,margin=18mm]{geometry}
\usepackage{paracol}
\begin{document}
\section{Before}
The preview should first open through the exact full-page path.

\begin{paracol}{2}
\section{Left Track}
The left column includes the realtime sentinel word alphaomega.
\switchcolumn
\section{Right Track}
The right column remains separate.
\end{paracol}

\section{After}
Back to normal width.
\end{document}`);
    const source = liveEng.getSource();
    const idx = source.indexOf('alphaomega');
    assert.ok(idx > 0);
    const editReport = await liveEng.edit(idx, idx + 'alphaomega'.length, 'betagamma');
    assert.equal(editReport.stats.fullPagePreviewPending, true);
    assert.equal(editReport.stats.fullPagePreview, false, 'edit returns the resident live preview while exact rebuild is queued');
    assert.ok(editReport.patches.some((p) => p.type === 'replace-page'), 'edit produces immediate page patches');
    assert.ok(editReport.dirtyPages.length > 0, 'immediate preview marks dirty pages');
    assert.ok(
      editReport.stats.diagnostics.some((d) => d.includes('live preview patched')),
      'diagnostic explains live preview plus queued exact rebuild'
    );
  } finally {
    await liveEng.close();
    rmSync(LIVE_WORK, { recursive: true, force: true });
  }
});
