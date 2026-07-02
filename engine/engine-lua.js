// LuaTeX-backed TDOM engine.
//
// Same resident incremental architecture as the internal engine — Source DOM
// block diffing, dependency propagation, Page DOM reuse, display-list
// patches — but typesetting is done by a real lualatex: each dirty block is
// compiled in isolation with injected counter/label state, yielding a chunk
// SVG (real fonts, real Knuth-Plass lines, real math) plus the true galley
// metrics TeX produced for it.
//
// Structure-changing edits (preamble packages, class options) trigger the
// allowed "recompile" path: format rebuild + all blocks dirty. Everything
// else — sentences, equations, macros, labels — updates incrementally.

import { performance } from 'node:perf_hooks';
import { SourceStore } from './source-store.js';
import { fnv1a } from './hash.js';
import { tokenize, readGroup } from './tokenizer.js';
import { segmentBody, documentBounds, diffBlocks } from './segmenter.js';
import { scanMacros, changedMacros } from './macro-vm.js';
import { paginate, reconcilePages } from './page.js';
import { LuaTexBackend } from './luatex/backend.js';
import { readFileSync } from 'node:fs';

const MAX_STATE_PASSES = 4;
const CHUNK_STORE_LIMIT = 600;

const HEADING_RE = /^\s*\\(section|subsection|subsubsection|paragraph)\b/;

export class LuaTDOMEngine {
  constructor({ workDir }) {
    this.store = new SourceStore();
    this.backend = new LuaTexBackend(workDir);
    this.file = 'main.tex';
    this.blocks = [];
    this.preHash = null;
    this.macroTable = new Map();
    this.geometry = null;
    this.labelValues = new Map(); // key -> {num, page}
    this.pages = [];
    this.chunkStore = new Map(); // contentId -> {svg, wBp, hBp}
    this.cacheKeyToChunk = new Map(); // compile cache: key -> result record
    this.idSeq = 1;
    this.rev = 0;
    this.backendName = 'lualatex';
  }

  async open(text, file = 'main.tex') {
    this.file = file;
    this.store.open(file, text);
    this.blocks = [];
    this.preHash = null;
    this.labelValues = new Map();
    this.pages = [];
    return this.#update({ editLabel: 'open' });
  }

  async edit(start, end, replacement, file = this.file) {
    const p1 = this.store.position(file, start);
    const p2 = this.store.position(file, end);
    const editLabel = `${file}:${p1.line}:${p1.column}-${p2.line}:${p2.column}`;
    this.store.applyEdit(file, start, end, replacement);
    return this.#update({ editLabel });
  }

  getSource() {
    return this.store.get(this.file);
  }

  getDisplayLists() {
    return this.pages.map((p) => p.dl);
  }

  getChunkSVG(id) {
    return this.chunkStore.get(id)?.svg ?? null;
  }

  getGeometry() {
    return this.geometry;
  }

  getDOM() {
    const blockPages = new Map();
    for (const page of this.pages) {
      for (const { u } of page.units) {
        if (!blockPages.has(u.blockId)) blockPages.set(u.blockId, []);
        const arr = blockPages.get(u.blockId);
        if (arr[arr.length - 1] !== page.number) arr.push(page.number);
      }
    }
    return {
      rev: this.rev,
      backend: this.backendName,
      pageCount: this.pages.length,
      blocks: this.blocks.map((b) => ({
        id: b.id,
        type: b.kind ?? 'block',
        source: {
          file: this.file,
          start: this.store.position(this.file, b.start),
          end: this.store.position(this.file, b.end),
        },
        labels: (b.labelsDefined ?? []).map((l) => l.key),
        refs: b.usesRefs ?? [],
        consumesState: !!b.consumesState,
        chunk: b.chunkId ?? null,
        pages: blockPages.get(b.id) ?? [],
      })),
      labels: Object.fromEntries([...this.labelValues].map(([k, v]) => [k, v.num])),
    };
  }

  async exportPDF() {
    const pdfPath = await this.backend.fullCompile(this.getSource());
    return readFileSync(pdfPath);
  }

  // ------------------------------------------------------------- pipeline

  async #update({ editLabel }) {
    const t = new Timer();
    const text = this.store.get(this.file);
    const diagnostics = [];

    // --- 1. preamble: format + macro dependency diff ---------------------
    const bounds = documentBounds(text);
    const preambleText = text.slice(bounds.preamble.start, bounds.preamble.end);
    const preHash = fnv1a(preambleText);
    let macroDirtyNames = new Set();
    let allDirty = false;
    let fmtRebuilt = false;
    if (preHash !== this.preHash) {
      const newTable = scanMacros(preambleText);
      const delta = changedMacros(this.macroTable, newTable);
      const macroOnly =
        this.preHash !== null &&
        stripMacroDefs(preambleText) === stripMacroDefs(this.lastPreambleText ?? '');
      await this.backend.prepare(preambleText);
      fmtRebuilt = true;
      this.geometry = this.backend.geometry;
      diagnostics.push(...this.backend.diagnostics);
      if (macroOnly) {
        macroDirtyNames = macroClosure(delta, newTable);
      } else {
        allDirty = true;
      }
      this.macroTable = newTable;
      this.preHash = preHash;
      this.lastPreambleText = preambleText;
    }
    t.lap('preamble');

    // --- 2. Source DOM: segment + diff -----------------------------------
    const segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
    const diff = diffBlocks(this.blocks, segs, () => this.idSeq++);
    this.blocks = diff.blocks;
    const dirtySource = new Set(diff.dirty);
    for (const block of this.blocks) {
      if (!block.usesRefs || dirtySource.has(block.id)) annotateBlock(block, this.backend.counters);
    }
    const macroRegexes = [...macroDirtyNames]
      .filter((n) => /^[a-zA-Z@]+$/.test(n))
      .map((n) => new RegExp('\\\\' + n + '(?![a-zA-Z@])'));
    t.lap('segment');

    // --- 3. state-chained compile passes ----------------------------------
    const dirtySemantic = new Set();
    const depDirty = [];
    let compiledBlocks = 0;
    let chunkCacheHits = 0;
    let lualatexMs = 0;
    let svgMs = 0;
    let changedLabels = new Set();

    const counters = this.backend.counters;
    const stateJson = (s) => JSON.stringify(counters.map((c) => s?.[c] ?? 0));

    for (let pass = 0; pass < MAX_STATE_PASSES; pass++) {
      const jobs = [];
      let entry = Object.fromEntries(counters.map((c) => [c, 0]));
      for (const block of this.blocks) {
        const entryJson = stateJson(entry);
        const refVals = (block.usesRefs ?? [])
          .map((k) => `${k}=${this.labelValues.get(k)?.num ?? '??'}`)
          .join(',');
        const noindent = this.#noindentFor(block);
        const cacheKey = fnv1a(
          `${preHash}|${block.hash}|${entryJson}|${refVals}|${noindent ? 1 : 0}`
        );

        let needs = false;
        if (pass === 0) {
          if (!block.items || dirtySource.has(block.id) || allDirty) needs = true;
          else if (macroRegexes.some((re) => re.test(block.text))) {
            needs = true;
            push2(depDirty, 'macro', 'preamble', block.id);
          }
        }
        if (!needs && block.cacheKey !== cacheKey) {
          // entry state or referenced label changed
          if (block.entryJson !== entryJson && block.consumesState) {
            needs = true;
            if (pass > 0 || !dirtySource.has(block.id)) push2(depDirty, 'counter', 'chain', block.id);
          } else if (block.refVals !== refVals) {
            needs = true;
            for (const k of block.usesRefs ?? []) {
              if ((this.labelValues.get(k)?.num ?? '??') !== extractRefVal(block.refVals, k)) {
                push2(depDirty, 'label', k, block.id);
              }
            }
          }
        }

        if (needs) {
          const cached = this.cacheKeyToChunk.get(cacheKey);
          if (cached) {
            chunkCacheHits++;
            this.#adopt(block, cached, entryJson, refVals, cacheKey);
          } else {
            jobs.push({ id: block.id, text: block.text, entryState: { ...entry }, noindent, refVals });
          }
          dirtySemantic.add(block.id);
        }
        // advance the counter chain: deltas make isolated compiles composable
        if (block.stateDelta) {
          entry = { ...entry };
          for (const [k, v] of Object.entries(block.stateDelta)) entry[k] = (entry[k] ?? 0) + v;
        }
      }

      // Full builds (open / preamble change) compile every block in document
      // order in one run — let the counters chain naturally inside TeX.
      if (jobs.length && jobs.length === this.blocks.length) {
        for (const job of jobs) job.entryState = null;
      }

      const oldLabels = new Map(this.labelValues);
      if (jobs.length) {
      const labelsForTeX = new Map(
        [...this.labelValues].map(([k, v]) => [k, { num: v.num, page: v.page }])
      );
      const { results, pdfPath, lualatexMs: ms } = await this.backend.compileBlocks(jobs, labelsForTeX);
      lualatexMs += ms;
      compiledBlocks += jobs.length;

      for (const job of jobs) {
        const block = this.blocks.find((b) => b.id === job.id);
        if (!block) continue;
        const res = results.get(job.id);
        if (!res || res.error) {
          diagnostics.push(`block ${job.id}: ${res?.error ?? 'no output'} (showing last good version)`);
          if (!block.items) {
            const rec = errorRecord(res?.error ?? 'compile error');
            this.chunkStore.set(rec.chunkId, { svg: rec.__errorSvg, wBp: rec.wBp, hBp: rec.hBp + rec.dBp });
            this.#adopt(block, rec, job.entryJson, job.refVals, job.cacheKey);
          }
          continue;
        }
        const t0 = performance.now();
        const svg = await this.backend.chunkSVG(pdfPath, res.page);
        svgMs += performance.now() - t0;
        const contentId = fnv1a(svg + JSON.stringify(res.items));
        if (!this.chunkStore.has(contentId)) {
          this.chunkStore.set(contentId, { svg, wBp: res.wBp, hBp: res.hBp + res.dBp });
          trimStore(this.chunkStore, CHUNK_STORE_LIMIT);
        }
        // Counter effects are stored as deltas so an isolated compile's
        // absolute values compose correctly into the document chain.
        const stateDelta = {};
        for (const c of counters) {
          const d = (res.exit[c] ?? 0) - (res.entry[c] ?? 0);
          if (d !== 0) stateDelta[c] = d;
        }
        const realEntryJson = stateJson(res.entry);
        const realKey = fnv1a(
          `${preHash}|${block.hash}|${realEntryJson}|${job.refVals}|${job.noindent ? 1 : 0}`
        );
        const record = {
          chunkId: contentId,
          items: res.items,
          stateDelta,
          labelsDefined: res.labels,
          wBp: res.wBp,
          hBp: res.hBp,
          dBp: res.dBp,
        };
        this.cacheKeyToChunk.set(realKey, record);
        trimStore(this.cacheKeyToChunk, CHUNK_STORE_LIMIT);
        this.#adopt(block, record, realEntryJson, job.refVals, realKey);
        block.consumesState = block.consumesState || Object.keys(stateDelta).length > 0;
      }
      } // if (jobs.length)

      // Rebuild the label table every pass — cache adoptions change label
      // values too (e.g. reverting an edit restores old numbers without any
      // compile). New label deltas trigger another pass for their ref-users.
      const newLabels = new Map();
      for (const block of this.blocks) {
        for (const l of block.labelsDefined ?? []) newLabels.set(l.key, { num: l.num, page: l.page });
      }
      this.labelValues = newLabels;
      let labelsMoved = false;
      for (const [k, v] of newLabels) {
        if (oldLabels.get(k)?.num !== v.num) {
          changedLabels.add(k);
          labelsMoved = true;
        }
      }
      for (const k of oldLabels.keys()) {
        if (!newLabels.has(k)) {
          changedLabels.add(k);
          labelsMoved = true;
        }
      }
      if (!jobs.length && !labelsMoved) break;
    }
    t.lap('compile');

    // --- 4. units: real galley items -> pagination units ------------------
    // Units are cached per block (keyed by chunk + inter-block glue input)
    // so unchanged blocks contribute reference-identical unit objects and
    // pages can be adopted wholesale by the reconciler.
    const geo = this.geometry;
    let prevLastBox = null;
    for (const block of this.blocks) {
      const sig = `${block.chunkId}|${prevLastBox ? prevLastBox.d : 'none'}`;
      if (!block.units || block.unitsSig !== sig) {
        block.units = buildUnits(block, geo, prevLastBox);
        block.unitsSig = sig;
      }
      const boxes = (block.items ?? []).filter((i) => i.kind === 'box');
      if (boxes.length) prevLastBox = boxes[boxes.length - 1];
    }
    const stream = [];
    for (const block of this.blocks) stream.push(...block.units);
    t.lap('units');

    // --- 5. Page DOM + display lists + patches ----------------------------
    const rawPages = paginate(stream, geo.textheight);
    const { pages, reused, rebuilt } = reconcilePages(rawPages, this.pages);
    const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
    const prevCount = this.pages.length;
    const patches = [];
    const dirtyPages = [];
    for (const page of pages) {
      if (!page.dl) page.dl = this.#displayList(page, geo);
      if (page.dl.hash !== prevHashes.get(page.number)) {
        dirtyPages.push(page.number);
        patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      }
    }
    if (pages.length < prevCount) patches.push({ type: 'remove-pages', from: pages.length + 1 });
    this.pages = pages;
    // refresh label page numbers from real pagination (aux-style latency)
    for (const page of pages) {
      for (const { u } of page.units) {
        const block = this.blocks.find((b) => b.id === u.blockId);
        for (const l of block?.labelsDefined ?? []) {
          const cur = this.labelValues.get(l.key);
          if (cur) cur.page = String(page.number);
        }
      }
    }
    t.lap('paginate');

    this.rev++;
    return {
      rev: this.rev,
      edit: editLabel,
      backend: this.backendName,
      dirtySourceNodes: [...dirtySource].map((id) => 'src-' + id),
      dirtySemanticNodes: [...dirtySemantic].map((id) => 'blk-' + id),
      dirtyDependencies: depDirty,
      dirtyLayoutNodes: [...dirtySemantic].map((id) => 'chunk-' + id),
      dirtyPages,
      patches,
      stats: {
        ...t.done(),
        blocksTotal: this.blocks.length,
        blocksCompiled: compiledBlocks,
        chunkCacheHits,
        semanticCacheHits: this.blocks.length - compiledBlocks,
        layoutCacheHits: this.blocks.length - compiledBlocks,
        layoutCacheMisses: compiledBlocks,
        blocksReparsed: compiledBlocks,
        lualatexMs: Math.round(lualatexMs),
        svgMs: Math.round(svgMs),
        fmtRebuilt,
        pagesReused: reused,
        pagesRebuilt: rebuilt,
        pageCount: pages.length,
        macrosChanged: [...macroDirtyNames],
        labelsChanged: [...changedLabels],
        diagnostics,
      },
    };
  }

  #adopt(block, record, entryJson, refVals, cacheKey) {
    block.chunkId = record.chunkId;
    block.items = record.items;
    block.stateDelta = record.stateDelta ?? {};
    block.labelsDefined = record.labelsDefined;
    block.wBp = record.wBp;
    block.hBp = record.hBp;
    block.dBp = record.dBp;
    block.entryJson = entryJson;
    block.refVals = refVals;
    block.cacheKey = cacheKey;
  }

  #noindentFor(block) {
    const idx = this.blocks.indexOf(block);
    if (idx <= 0) return true;
    return HEADING_RE.test(this.blocks[idx - 1].text);
  }

  #displayList(page, geo) {
    const leftMargin = 72 + (geo.oddsidemargin ?? 0);
    const topMargin = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
    const commands = [];
    let open = null; // { chunk, x, top, clip0, clip1 }
    const flush = () => {
      if (!open) return;
      commands.push({
        op: 'chunk',
        chunk: open.chunk,
        x: r2(open.x),
        y: r2(open.top + open.clip0),
        w: r2(open.w),
        h: r2(open.clip1 - open.clip0),
        sy: r2(open.clip0), // source-y offset within the chunk
        src: open.blockId,
      });
      open = null;
    };
    for (const { u, y } of page.units) {
      const c = u.ln.chunk;
      if (!c) continue;
      const unitTop = y - u.ln.boxH; // y is the baseline (= top + boxH)
      const chunkTop = topMargin + unitTop - c.yOff;
      const clip0 = c.yOff;
      const clip1 = c.yOff + u.h;
      if (open && open.chunk === c.hash && Math.abs(open.top - chunkTop) < 0.05 && clip0 <= open.clip1 + 0.05) {
        open.clip1 = Math.max(open.clip1, clip1);
      } else {
        flush();
        const meta = this.chunkStore.get(c.hash);
        open = { chunk: c.hash, blockId: u.blockId, x: leftMargin, top: chunkTop, clip0, clip1, w: meta?.wBp ?? c.w };
      }
    }
    flush();
    commands.push({
      op: 'folio',
      x: r2(geo.paperwidth / 2),
      y: r2(geo.paperheight - Math.max(36, (geo.paperheight - topMargin - geo.textheight) / 2)),
      text: String(page.number),
    });
    const dl = { page: page.number, commands };
    dl.hash = fnv1a(JSON.stringify(commands));
    return dl;
  }
}

// -------------------------------------------------------------- helpers

function annotateBlock(block, counters) {
  const refs = [];
  const re = /\\(ref|eqref|pageref|autoref|cref)\*?\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(block.text))) refs.push(m[2]);
  block.usesRefs = [...new Set(refs)];
  const envNames = ['equation', 'align', 'gather', 'multline', 'eqnarray', 'figure', 'table', ...counters];
  const stateRe = new RegExp(
    '\\\\(section|subsection|subsubsection|paragraph|caption|footnote|label|item|stepcounter|refstepcounter)\\b' +
      '|\\\\begin\\{(' + envNames.map(escapeRe).join('|') + ')\\*?\\}'
  );
  block.consumesState = stateRe.test(block.text);
  block.kind = HEADING_RE.test(block.text)
    ? 'heading'
    : /^\s*\\begin\{(equation|align|gather|multline)/.test(block.text) || /^\s*\\\[/.test(block.text)
      ? 'displaymath'
      : /^\s*\\begin\{(figure|table)/.test(block.text)
        ? 'float'
        : 'paragraph';
}

/** Build pagination units from a block's galley items. */
function buildUnits(block, geo, prevLastBox) {
  const items = block.items ?? [];
  const units = [];
  let pending = 0;
  let li = 0;
  let first = true;
  let lastUnit = null;
  for (const it of items) {
    if (it.kind === 'glue' || it.kind === 'kern') {
      pending += it.amount;
      continue;
    }
    if (it.kind === 'penalty') {
      if (it.value >= 10000 && lastUnit) lastUnit.keepWithNext = true;
      continue;
    }
    // box
    let pre = pending;
    if (first) {
      // synthesize TeX's interline glue across the block boundary
      if (prevLastBox) {
        const inter = Math.max(
          geo.lineskip ?? 1,
          (geo.baselineskip ?? 14.5) - (prevLastBox.d ?? 0) - it.h
        );
        pre += inter + (geo.parskip ?? 0);
      }
      first = false;
    }
    const unit = {
      blockId: block.id,
      li: li++,
      h: it.h + it.d,
      pre,
      post: 0,
      keepWithNext: false,
      ln: {
        descent: it.d,
        // height above the baseline only: pagination stores the baseline as
        // top + boxH, and the display list recovers the top from it.
        boxH: it.h,
        chunk: { hash: block.chunkId, yOff: it.y, w: block.wBp },
      },
    };
    units.push(unit);
    lastUnit = unit;
    pending = 0;
  }
  if (lastUnit) lastUnit.post += pending;
  // headings keep with following block
  if (block.kind === 'heading' && lastUnit) lastUnit.keepWithNext = true;
  return units;
}

function macroClosure(changed, table) {
  const closure = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, def] of table) {
      if (closure.has(name)) continue;
      for (const other of closure) {
        if (new RegExp('\\\\' + other + '(?![a-zA-Z@])').test(def.src ?? '')) {
          closure.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return closure;
}

/** Remove macro definitions from a preamble, leaving the structural rest. */
export function stripMacroDefs(preamble) {
  const toks = tokenize(preamble, 0);
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === 'cs' && ['newcommand', 'renewcommand', 'providecommand', 'def'].includes(tk.name)) {
      i++;
      if (toks[i]?.t === 'ch' && toks[i].c === '*') i++;
      if (toks[i]?.t === '{') i = readGroup(toks, i).next;
      else if (toks[i]?.t === 'cs') i++;
      while (toks[i]?.t === 'ch' && toks[i].c === '[') {
        while (i < toks.length && !(toks[i].t === 'ch' && toks[i].c === ']')) i++;
        i++;
      }
      if (toks[i]?.t === '{') i = readGroup(toks, i).next;
      continue;
    }
    if (tk.t === 'cs') out.push('\\' + tk.name);
    else if (tk.t === 'ch') out.push(tk.c);
    else if (tk.t === '{') out.push('{');
    else if (tk.t === '}') out.push('}');
    i++;
  }
  return out.join('');
}

function errorRecord(message) {
  const w = 345;
  const h = 14;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#ffe5e5"/>` +
    `<text x="4" y="10" font-family="monospace" font-size="8" fill="#b00">! ${escapeXml(message).slice(0, 120)}</text></svg>`;
  const chunkId = fnv1a('error|' + message);
  return {
    chunkId,
    items: [{ kind: 'box', y: 0, w, h: 10, d: 4 }],
    stateDelta: {},
    labelsDefined: [],
    wBp: w,
    hBp: 10,
    dBp: 4,
    __errorSvg: svg,
  };
}

function trimStore(map, limit) {
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function extractRefVal(refVals, key) {
  const m = (refVals ?? '').match(new RegExp(escapeRe(key) + '=([^,]*)'));
  return m ? m[1] : undefined;
}

function push2(list, kind, key, blockId) {
  let entry = list.find((e) => e.kind === kind && e.key === key);
  if (!entry) {
    entry = { kind, key, affected: [] };
    list.push(entry);
  }
  if (!entry.affected.includes('blk-' + blockId)) entry.affected.push('blk-' + blockId);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXml(s) {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

function r2(v) {
  return Math.round(v * 100) / 100;
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
