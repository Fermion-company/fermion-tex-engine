// TDOM Engine — the resident incremental TeX runtime.
//
// Holds the full document state between edits:
//   Source Store -> Source DOM (blocks) -> Macro VM -> Semantic DOM
//   -> Dependency Graph (macros / labels / counters)
//   -> Layout DOM -> Page DOM -> Display Lists
//
// edit() applies a text delta and re-evaluates only what the change reaches,
// answering the one question that defines this project:
//   "この1文字変更で、何がdirtyになるか？"

import { performance } from 'node:perf_hooks';
import { SourceStore } from './source-store.js';
import { fnv1a } from './hash.js';
import { tokenize } from './tokenizer.js';
import { segmentBody, documentBounds, diffBlocks } from './segmenter.js';
import { scanMacros, changedMacros, expandTokens } from './macro-vm.js';
import { buildSemanticNode, semSerial } from './semantic.js';
import { layoutBlock, PAGE, STYLE } from './layout.js';
import { paginate, reconcilePages } from './page.js';
import { buildDisplayList } from './display-list.js';
import { exportPDF } from './pdf.js';

export class TDOMEngine {
  constructor() {
    this.store = new SourceStore();
    this.file = 'main.tex';
    this.blocks = [];
    this.macroTable = new Map();
    this.preHash = null;
    this.labelValues = new Map(); // label key -> display number
    this.pages = [];
    this.idSeq = 1;
    this.rev = 0;
  }

  /** Load a project (single main file for now) and build the initial DOM. */
  open(text, file = 'main.tex') {
    this.file = file;
    this.store.open(file, text);
    this.blocks = [];
    this.macroTable = new Map();
    this.preHash = null;
    this.labelValues = new Map();
    this.pages = [];
    return this.#update({ editLabel: 'open' });
  }

  /** Apply a text edit [start, end) -> replacement, re-evaluate, return report. */
  edit(start, end, replacement, file = this.file) {
    const p1 = this.store.position(file, start);
    const p2 = this.store.position(file, end);
    const editLabel = `${file}:${p1.line}:${p1.column}-${p2.line}:${p2.column}`;
    this.store.applyEdit(file, start, end, replacement);
    return this.#update({ editLabel });
  }

  getSource() {
    return this.store.get(this.file);
  }

  /** Snapshot of the DOM layers for inspection. */
  getDOM() {
    const blockPages = this.#pagesByBlock();
    return {
      rev: this.rev,
      pageCount: this.pages.length,
      blocks: this.blocks.map((b) => ({
        id: b.id,
        semanticId: b.sem?.id ?? null,
        type: b.sem?.type ?? 'unknown',
        source: {
          file: this.file,
          start: this.store.position(this.file, b.start),
          end: this.store.position(this.file, b.end),
        },
        labels: b.sem?.labels ?? [],
        refs: b.sem?.refs ?? [],
        usedMacros: b.exp ? [...b.exp.used.keys()] : [],
        layout: b.layout
          ? { id: b.layout.id, lines: b.layout.lines.length, height: Math.round(b.layout.height * 10) / 10 }
          : null,
        pages: blockPages.get(b.id) ?? [],
      })),
      labels: Object.fromEntries(this.labelValues),
      macros: Object.fromEntries(
        [...this.macroTable.values()].map((m) => [m.name, { params: m.nparams, body: m.src }])
      ),
    };
  }

  /** All current display lists (for initial paint / new viewers). */
  getDisplayLists() {
    return this.pages.map((p) => p.dl);
  }

  exportPDF() {
    return exportPDF(this.getDisplayLists());
  }

  // ------------------------------------------------------------ pipeline

  #update({ editLabel }) {
    const t = new Timer();
    const text = this.store.get(this.file);
    const diagnostics = [];

    // --- 1. preamble / Macro VM -----------------------------------------
    const bounds = documentBounds(text);
    const preambleText = text.slice(bounds.preamble.start, bounds.preamble.end);
    const preHash = fnv1a(preambleText);
    let macroDelta = new Set();
    if (preHash !== this.preHash) {
      const newTable = scanMacros(preambleText);
      macroDelta = changedMacros(this.macroTable, newTable);
      this.macroTable = newTable;
      this.preHash = preHash;
    }
    t.lap('macroScan');

    // --- 2. Source DOM: segment + diff ----------------------------------
    const bodyText = text.slice(bounds.body.start, bounds.body.end);
    const segs = segmentBody(bodyText, bounds.body.start);
    const diff = diffBlocks(this.blocks, segs, () => this.idSeq++);
    this.blocks = diff.blocks;
    const dirtySource = new Set(diff.dirty);
    t.lap('segment');

    // --- 3. Macro dependency propagation ---------------------------------
    // A block must re-expand if its text changed, or if a macro it consumed
    // (directly or via nested expansion) changed, or if a changed macro name
    // now appears textually (covers newly-defined macros).
    const macroRegexes = [...macroDelta]
      .filter((n) => /^[a-zA-Z@]+$/.test(n))
      .map((n) => ({ name: n, re: new RegExp('\\\\' + n + '(?![a-zA-Z@])') }));
    const depDirty = []; // {kind, key, affected:[semId]}
    const macroAffected = new Map(); // macro name -> [semIds]

    const needsRebuild = (block) => {
      if (!block.sem || dirtySource.has(block.id)) return true;
      if (macroDelta.size === 0) return false;
      if (block.exp) {
        for (const name of block.exp.used.keys()) {
          if (macroDelta.has(name)) {
            push(macroAffected, name, block.sem.id);
            return true;
          }
        }
      }
      for (const { name, re } of macroRegexes) {
        if (re.test(block.text)) {
          push(macroAffected, name, block.sem.id);
          return true;
        }
      }
      return false;
    };

    // --- 4. re-tokenize + re-expand + rebuild Semantic DOM ---------------
    const dirtySemantic = [];
    let reparsed = 0;
    for (const block of this.blocks) {
      if (!needsRebuild(block)) continue;
      reparsed++;
      try {
        const toks = tokenize(block.text, block.start);
        const used = new Map();
        const exp = expandTokens(toks, this.macroTable, used, 0, diagnostics);
        block.exp = { used };
        block.sem = buildSemanticNode(block, exp.toks, diagnostics);
      } catch (err) {
        diagnostics.push(`block ${block.id}: ${err.message}`);
        block.exp = { used: new Map() };
        block.sem = {
          id: 'para-' + block.id,
          blockId: block.id,
          type: 'paragraph',
          runs: [{ kind: 'text', text: block.text, style: { i: 0, b: 0, tt: 1 } }],
          centered: false,
          labels: [],
          refs: [],
        };
      }
      // Note: block.layout is kept — the layout cache key decides whether the
      // rebuilt semantics actually require a relayout (a comment-only or
      // whitespace-only edit does not).
      dirtySemantic.push(block.sem.id);
    }
    for (const [name, affected] of macroAffected) {
      depDirty.push({ kind: 'macro', key: '\\' + name, affected });
    }
    t.lap('semantic');

    // --- 5. counters + label table (Dependency Graph) --------------------
    const oldLabels = this.labelValues;
    const newLabels = new Map();
    let sec = 0;
    let sub = 0;
    let subsub = 0;
    for (const block of this.blocks) {
      const sem = block.sem;
      if (!sem) continue;
      if (sem.type === 'section') {
        if (sem.level === 1) { sec++; sub = 0; subsub = 0; }
        else if (sem.level === 2) { sub++; subsub = 0; }
        else subsub++;
        const num = sem.level === 1 ? `${sec}` : sem.level === 2 ? `${sec}.${sub}` : `${sec}.${sub}.${subsub}`;
        if (sem.number !== num) {
          sem.number = num; // layout key includes the number -> relayout
          if (!dirtySemantic.includes(sem.id)) {
            depDirty.push({ kind: 'counter', key: 'section', affected: [sem.id] });
          }
        }
      }
      const current = sec === 0 ? '??' : sub === 0 ? `${sec}` : `${sec}.${sub}`;
      for (const key of sem.labels ?? []) newLabels.set(key, current);
    }
    this.labelValues = newLabels;
    const labelDelta = new Set();
    for (const [k, v] of newLabels) if (oldLabels.get(k) !== v) labelDelta.add(k);
    for (const k of oldLabels.keys()) if (!newLabels.has(k)) labelDelta.add(k);

    if (labelDelta.size) {
      for (const block of this.blocks) {
        const refs = block.sem?.refs ?? [];
        const hit = refs.filter((k) => labelDelta.has(k));
        if (hit.length && !dirtySemantic.includes(block.sem.id)) {
          for (const k of hit) {
            push2(depDirty, 'label', k, block.sem.id);
          }
        }
      }
    }
    t.lap('deps');

    // --- 6. Layout DOM (per-block cache) ---------------------------------
    const refsResolver = (key) => this.labelValues.get(key) ?? '??';
    const dirtyLayout = [];
    let layoutHits = 0;
    let prevType = null;
    for (const block of this.blocks) {
      const sem = block.sem;
      const indent = prevType === 'paragraph' && sem.type === 'paragraph';
      const refsResolved = (sem.refs ?? []).map((k) => `${k}=${refsResolver(k)}`).join(',');
      const key = fnv1a(
        semSerial(sem) + '|' + (indent ? 1 : 0) + '|' + refsResolved + '|' + PAGE.textWidth + '|' + STYLE.fontSize
      );
      if (block.layout && block.layoutKey === key) {
        layoutHits++;
      } else {
        block.layout = layoutBlock(sem, { indent, refsResolver });
        block.layoutKey = key;
        dirtyLayout.push(block.layout.id);
      }
      prevType = sem.type;
    }
    t.lap('layout');

    // --- 7. Page DOM: repaginate + reuse ---------------------------------
    const stream = [];
    for (const block of this.blocks) {
      if (block.layout) stream.push(...block.layout.units);
    }
    const rawPages = paginate(stream);
    const { pages, reused, rebuilt } = reconcilePages(rawPages, this.pages);
    t.lap('paginate');

    // --- 8. Display Lists + Preview Patches ------------------------------
    const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
    const prevCount = this.pages.length;
    const patches = [];
    const dirtyPages = [];
    for (const page of pages) {
      if (!page.dl) page.dl = buildDisplayList(page);
      if (page.dl.hash !== prevHashes.get(page.number)) {
        dirtyPages.push(page.number);
        patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      }
    }
    if (pages.length < prevCount) {
      patches.push({ type: 'remove-pages', from: pages.length + 1 });
    }
    this.pages = pages;
    t.lap('display');

    this.rev++;
    return {
      rev: this.rev,
      edit: editLabel,
      dirtySourceNodes: [...dirtySource].map((id) => 'src-' + id),
      dirtySemanticNodes: dirtySemantic,
      dirtyDependencies: depDirty,
      dirtyLayoutNodes: dirtyLayout,
      dirtyPages,
      patches,
      stats: {
        ...t.done(),
        blocksTotal: this.blocks.length,
        blocksReparsed: reparsed,
        semanticCacheHits: this.blocks.length - reparsed,
        layoutCacheHits: layoutHits,
        layoutCacheMisses: this.blocks.length - layoutHits,
        pagesReused: reused,
        pagesRebuilt: rebuilt,
        pageCount: pages.length,
        macrosChanged: [...macroDelta],
        labelsChanged: [...labelDelta],
        diagnostics,
      },
    };
  }

  #pagesByBlock() {
    const map = new Map();
    for (const page of this.pages) {
      for (const { u } of page.units) {
        if (!map.has(u.blockId)) map.set(u.blockId, []);
        const arr = map.get(u.blockId);
        if (arr[arr.length - 1] !== page.number) arr.push(page.number);
      }
    }
    return map;
  }
}

class Timer {
  constructor() {
    this.t0 = performance.now();
    this.last = this.t0;
    this.laps = {};
  }
  lap(name) {
    const now = performance.now();
    this.laps[name + 'Us'] = Math.round((now - this.last) * 1000);
    this.last = now;
  }
  done() {
    this.laps.totalUs = Math.round((performance.now() - this.t0) * 1000);
    return this.laps;
  }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  if (!arr.includes(value)) arr.push(value);
}

function push2(list, kind, key, semId) {
  let entry = list.find((e) => e.kind === kind && e.key === key);
  if (!entry) {
    entry = { kind, key, affected: [] };
    list.push(entry);
  }
  if (!entry.affected.includes(semId)) entry.affected.push(semId);
}
