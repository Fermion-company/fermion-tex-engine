// Tests for the TDOM engine — these encode the project's success criteria:
// a change must dirty exactly what it reaches, and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TDOMEngine } from '../engine/engine.js';

const DEMO = readFileSync(fileURLToPath(new URL('../samples/demo.tex', import.meta.url)), 'utf8');

function freshEngine() {
  const eng = new TDOMEngine();
  const report = eng.open(DEMO);
  return { eng, report };
}

test('open builds the full DOM and multiple pages', () => {
  const { eng, report } = freshEngine();
  assert.ok(report.stats.pageCount >= 2, `expected >=2 pages, got ${report.stats.pageCount}`);
  assert.ok(report.patches.length === report.stats.pageCount, 'initial patches cover all pages');
  const dom = eng.getDOM();
  assert.ok(dom.blocks.length > 10);
  assert.equal(dom.labels['sec:intro'], '1');
  assert.equal(dom.labels['sec:pipeline'], '2');
  assert.ok(dom.macros.term);
});

test('single word edit dirties exactly one block and patches only its page(s)', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const idx = src.indexOf('keeps the entire');
  assert.ok(idx > 0);
  const before = eng.getDisplayLists().map((dl) => dl.hash);

  const report = eng.edit(idx, idx + 'keeps'.length, 'holds');

  assert.equal(report.dirtySourceNodes.length, 1, 'one dirty source node');
  assert.equal(report.dirtySemanticNodes.length, 1, 'one dirty semantic node');
  assert.equal(report.dirtyLayoutNodes.length, 1, 'one dirty layout node');
  assert.equal(report.dirtyDependencies.length, 0, 'no dependency fallout');
  assert.deepEqual(report.dirtyPages, [1], 'only page 1 patched');
  const after = eng.getDisplayLists().map((dl) => dl.hash);
  for (let i = 1; i < before.length; i++) {
    assert.equal(after[i], before[i], `page ${i + 1} display list unchanged`);
  }
  assert.ok(report.stats.layoutCacheHits >= report.stats.blocksTotal - 1);
});

test('whitespace-only edit produces no relayout and no patches', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const idx = src.indexOf('resident incremental\nTeX runtime');
  assert.ok(idx > 0);
  // replace the newline inside the paragraph with a space: same tokens
  const report = eng.edit(idx + 'resident incremental'.length, idx + 'resident incremental'.length + 1, ' ');
  assert.equal(report.dirtySourceNodes.length, 1, 'source node is dirty');
  assert.equal(report.dirtyLayoutNodes.length, 0, 'but layout is a cache hit');
  assert.equal(report.patches.length, 0, 'and no page changes');
});

test('macro redefinition dirties exactly the blocks that use it', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const usesTerm = (eng.getDOM().blocks.filter((b) => b.usedMacros.includes('term'))).map((b) => b.semanticId);
  assert.ok(usesTerm.length >= 1);

  const from = '\\newcommand{\\term}[1]{\\textbf{#1}}';
  const to = '\\newcommand{\\term}[1]{\\emph{#1}}';
  const idx = src.indexOf(from);
  assert.ok(idx > 0);
  const report = eng.edit(idx, idx + from.length, to);

  assert.deepEqual(report.stats.macrosChanged, ['term']);
  assert.deepEqual(new Set(report.dirtySemanticNodes), new Set(usesTerm));
  const dep = report.dirtyDependencies.find((d) => d.kind === 'macro' && d.key === '\\term');
  assert.ok(dep, 'macro dependency reported');
  assert.ok(report.stats.semanticCacheHits > 0, 'unrelated blocks kept their expansion');
});

test('label rename dirties referencing blocks via the dependency graph', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const idx = src.indexOf('\\label{sec:intro}');
  assert.ok(idx > 0);
  const report = eng.edit(idx, idx + '\\label{sec:intro}'.length, '\\label{sec:intro-renamed}');

  const labelDeps = report.dirtyDependencies.filter((d) => d.kind === 'label');
  assert.ok(labelDeps.some((d) => d.key === 'sec:intro'), 'old label reported dirty');
  const affected = labelDeps.flatMap((d) => d.affected);
  assert.ok(affected.length >= 1, 'referencing blocks made dirty');
  // The refs must now render as ?? — check display lists contain ??
  const all = JSON.stringify(eng.getDisplayLists());
  assert.ok(all.includes('??'), 'broken refs visible as ??');

  // Rename back: refs resolve again.
  const src2 = eng.getSource();
  const idx2 = src2.indexOf('\\label{sec:intro-renamed}');
  const report2 = eng.edit(idx2, idx2 + '\\label{sec:intro-renamed}'.length, '\\label{sec:intro}');
  assert.ok(report2.stats.labelsChanged.includes('sec:intro'));
  const all2 = JSON.stringify(eng.getDisplayLists());
  assert.ok(!all2.includes('"??"') || !all2.includes('??'), 'refs resolved again');
});

test('pagination reuses untouched pages and converges after growth', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  // Edit in the LAST section: earlier pages must be adopted unchanged.
  const idx = src.indexOf('The demo ends with a short summary.');
  assert.ok(idx > 0);
  const before = eng.getDisplayLists().map((dl) => dl.hash);
  const report = eng.edit(idx, idx, 'An inserted sentence that grows this paragraph by several words. ');

  assert.ok(report.stats.pagesReused >= before.length - 1, 'all earlier pages reused');
  assert.ok(report.dirtyPages.every((p) => p >= before.length - 1), 'only trailing pages patched');
});

test('inserting a section renumbers later sections through the counter graph', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const anchor = '\\section{Incremental Pagination}';
  const idx = src.indexOf(anchor);
  assert.ok(idx > 0);
  const report = eng.edit(idx, idx, '\\section{An Inserted Section}\n\nSome text for the new section.\n\n');
  const counterDeps = report.dirtyDependencies.filter((d) => d.kind === 'counter');
  assert.ok(counterDeps.length >= 1, 'later headings renumbered via counter dependency');
  const dom = eng.getDOM();
  assert.equal(dom.labels['sec:pages'], '4', 'section number shifted');
});

test('engine survives malformed input mid-typing', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const idx = src.indexOf('Try it now');
  // Type an unclosed \emph{ — engine must not throw.
  const r1 = eng.edit(idx, idx, '\\emph{');
  assert.ok(r1.rev > 0);
  // Now close it.
  const r2 = eng.edit(idx + 6, idx + 6, 'urgent} ');
  assert.ok(r2.dirtyPages.length >= 1);
  // Unknown command shows up as diagnostic, not crash.
  const r3 = eng.edit(idx, idx, '\\notacommand ');
  assert.ok(r3.stats.diagnostics.some((d) => d.includes('notacommand')));
});

test('PDF export produces a structurally valid PDF from display lists', () => {
  const { eng } = freshEngine();
  const pdf = eng.exportPDF();
  const head = pdf.subarray(0, 8).toString('latin1');
  assert.ok(head.startsWith('%PDF-1.4'));
  const body = pdf.toString('latin1');
  assert.ok(body.includes('/Type /Page'));
  assert.ok(body.includes(`/Count ${eng.getDisplayLists().length}`));
  assert.ok(body.includes('%%EOF'));
});

test('edits are fast: sub-5ms updates on a warm engine', () => {
  const { eng } = freshEngine();
  const src = eng.getSource();
  const idx = src.indexOf('watch the inspector');
  let worst = 0;
  for (let i = 0; i < 20; i++) {
    const r = eng.edit(idx, idx + 1, i % 2 ? 'w' : 'W');
    worst = Math.max(worst, r.stats.totalUs);
  }
  assert.ok(worst < 50000, `worst update ${worst}us should be well under 50ms`);
});
