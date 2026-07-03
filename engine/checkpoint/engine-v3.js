// CheckpointEngine — the endgame architecture.
//
// A single resident lualatex process tree holds the document. Every block
// boundary is a fork()ed checkpoint: a copy-on-write snapshot of the COMPLETE
// TeX state. An edit kills the stale suffix of the chain and resumes from the
// last valid snapshot, so the foreground cost of a keystroke is:
//
//   fork (~0.2ms) + typeset the changed block (+1 verification block)
//   + node-walk galley extraction + JSON over a local socket
//
// — typically single-digit milliseconds. There is no process start, no
// preamble reload, no font reload, no PDF and no external converter on the
// hot path: display lists carry TeX's own glyph positions and the browser
// draws them with the very font files TeX used.
//
// Graphics blocks (pdf literals: TikZ etc.) take an exact-render detour:
// a render child ships the block as a real PDF page which pdftocairo turns
// into an SVG chunk, swapped in asynchronously.

import net from 'node:net';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SourceStore } from '../source-store.js';
import { fnv1a } from '../hash.js';
import { segmentBody, documentBounds, diffBlocks } from '../segmenter.js';
import { paginate, reconcilePages } from '../page.js';
import { mapLegacyFont, remapText } from './mathmap.js';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

const BASE_COUNTERS = [
  'part', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];
const HEADING_RE = /^\s*\\(section|subsection|subsubsection|paragraph)\b/;
const JOB_TIMEOUT = 30_000;
const BOOT_TIMEOUT = 120_000;

export class CheckpointEngine {
  constructor({ workDir }) {
    this.workDir = path.resolve(workDir);
    mkdirSync(this.workDir, { recursive: true });
    this.store = new SourceStore();
    this.file = 'main.tex';
    this.blocks = [];
    this.idSeq = 1;
    this.rev = 0;

    this.server = null;
    this.port = 0;
    this.root = null; // ChildProcess of the root lualatex
    this.checkpoints = new Map(); // idx -> Peer (state after blocks[0..idx-1])
    this.peers = new Set();
    this.waiters = new Map(); // key -> {resolve, reject, timer}

    this.geometry = null;
    this.counters = [...BASE_COUNTERS];
    this.preHash = null;
    this.labelTable = new Map(); // key -> value (for reboot injection)
    this.fonts = new Map(); // fid -> {file,name,size,fmt, family, remap}
    this.fontFiles = new Map(); // familyKey -> absolute path
    this.pages = [];
    this.chunks = new Map(); // blockId -> {svg, wBp, hBp} exact renders (gfx)
    this.bgAbort = false;
    this.bgTask = Promise.resolve();
    this.onAsyncPatches = null; // callback(report-ish) for gfx swaps
    this.backendName = 'checkpoint';
    this.diagnostics = [];
  }

  // ------------------------------------------------------------ lifecycle

  async open(text, file = 'main.tex') {
    this.file = file;
    this.store.open(file, text);
    this.blocks = [];
    this.labelTable = new Map();
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

  async close() {
    this.bgAbort = true;
    for (const peer of this.peers) peer.send('DIE\n');
    if (this.root) {
      try { this.root.kill('SIGKILL'); } catch { /* gone */ }
    }
    if (this.server) this.server.close();
    this.checkpoints.clear();
    this.peers.clear();
  }

  getSource() {
    return this.store.get(this.file);
  }

  getDisplayLists() {
    return this.pages.map((p) => p.dl);
  }

  getGeometry() {
    return this.geometry;
  }

  getFontFile(key) {
    const p = this.fontFiles.get(key);
    if (!p || !existsSync(p)) return null;
    return readFileSync(p);
  }

  getFontManifest() {
    return [...this.fontFiles.keys()];
  }

  getChunkSVG(id) {
    return this.chunks.get(id)?.svg ?? null;
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
      checkpoints: [...this.checkpoints.keys()].sort((a, b) => a - b),
      blocks: this.blocks.map((b, i) => ({
        id: b.id,
        index: i,
        type: b.kind ?? 'block',
        gfx: !!b.gfx,
        source: {
          file: this.file,
          start: this.store.position(this.file, b.start),
          end: this.store.position(this.file, b.end),
        },
        labels: (b.galley?.labels ?? []).map((l) => l.k),
        refs: b.galley?.refs ?? [],
        pages: blockPages.get(b.id) ?? [],
      })),
      labels: Object.fromEntries(this.labelTable),
    };
  }

  async exportPDF() {
    // The honest full path: a real 2-pass lualatex over the actual source.
    const p = path.join(this.workDir, 'export.tex');
    writeFileSync(p, this.getSource());
    const run = () =>
      execFileP('lualatex', ['-interaction=nonstopmode', 'export.tex'], {
        cwd: this.workDir,
        timeout: 120_000,
      }).catch(() => {});
    await run();
    await run();
    const pdf = path.join(this.workDir, 'export.pdf');
    if (!existsSync(pdf)) throw new Error('full compile failed');
    return readFileSync(pdf);
  }

  // ---------------------------------------------------------- root/daemon

  async #ensureShim() {
    const so = path.join(this.workDir, 'tdomfork.so');
    const src = path.join(DIR, 'tdomfork.c');
    if (existsSync(so)) return;
    const args =
      process.platform === 'darwin'
        ? ['-O2', '-shared', '-undefined', 'dynamic_lookup', '-o', so, src]
        : ['-O2', '-shared', '-fPIC', '-o', so, src];
    await execFileP('cc', args, { timeout: 60_000 });
  }

  async #ensureServer() {
    if (this.server) return;
    this.server = net.createServer((sock) => this.#accept(sock));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  #accept(sock) {
    const peer = new Peer(sock, this);
    this.peers.add(peer);
    sock.on('close', () => {
      this.peers.delete(peer);
      for (const [idx, p] of this.checkpoints) {
        if (p === peer) this.checkpoints.delete(idx);
      }
    });
  }

  #await(key, timeout = JOB_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`timeout waiting for ${key}`));
      }, timeout);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  _fulfill(key, value) {
    const w = this.waiters.get(key);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(key);
      w.resolve(value);
    }
  }

  // message dispatch from Peer
  _onMessage(peer, msg) {
    switch (msg.kind) {
      case 'HELLO':
        peer.role = msg.role;
        peer.pid = msg.pid;
        if (msg.role === 'ckpt' && msg.idx === 0) {
          this.checkpoints.set(0, peer);
          this._fulfill('ckpt:0', peer);
        }
        break;
      case 'GEO':
        this.geometry = msg.json;
        this._fulfill('geo', msg.json);
        break;
      case 'TWIN':
        this.twinMetrics = msg.json; // unicode -> [height, depth] bp at 10pt
        break;
      case 'GALLEY':
        this._fulfill('galley:' + msg.id, msg.json);
        break;
      case 'CKPT':
        this.checkpoints.set(msg.idx, peer);
        this._fulfill('ckpt:' + msg.idx, peer);
        break;
      case 'DONE':
        this._fulfill('render:' + msg.id, true);
        break;
    }
  }

  async #bootRoot() {
    await this.#ensureShim();
    await this.#ensureServer();
    // tear down any previous tree
    for (const peer of this.peers) peer.send('DIE\n');
    this.checkpoints.clear();
    if (this.root) {
      try { this.root.kill('SIGKILL'); } catch { /* gone */ }
      this.root = null;
    }
    this.fonts.clear();

    const text = this.store.get(this.file);
    const bounds = documentBounds(text);
    const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
    this.counters = [...BASE_COUNTERS, ...scanCounterDefs(preamble)];
    writeFileSync(path.join(this.workDir, 'driver.tex'), this.#driverSource(preamble));

    const ckptReady = this.#await('ckpt:0', BOOT_TIMEOUT);
    const geoReady = this.#await('geo', BOOT_TIMEOUT);
    this.root = spawn(
      'lualatex',
      ['--shell-escape', '-interaction=nonstopmode', 'driver.tex'],
      { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let rootLog = '';
    this.root.stdout.on('data', (d) => { rootLog += d; if (rootLog.length > 65536) rootLog = rootLog.slice(-32768); });
    this.root.stderr.on('data', (d) => { rootLog += d; });
    this.root.on('exit', (code) => {
      this.rootLog = rootLog;
    });
    this.rootLogRef = () => rootLog;

    await Promise.all([ckptReady, geoReady]).catch((err) => {
      throw new Error(
        `daemon boot failed: ${err.message}\n--- lualatex output tail ---\n${rootLog.slice(-2000)}`
      );
    });
  }

  #driverSource(preamble) {
    const L = [];
    L.push(preamble.trimEnd());
    L.push('\\begin{document}');
    L.push(`\\directlua{dofile('${luaStr(path.join(DIR, 'daemon.lua'))}')}`);
    L.push('\\makeatletter');
    L.push('\\newbox\\TDOMgalley');
    L.push('\\directlua{TDOM_BOXNUM=\\number\\TDOMgalley}');
    L.push(
      `\\directlua{tdom_boot(${this.port}, '${luaStr(this.workDir)}', {${this.counters
        .map((c) => `'${c}'`)
        .join(',')}})}`
    );
    L.push('\\directlua{tdom_geo()}');
    // label / ref recording shims (typesetting behavior unchanged)
    L.push('\\let\\TDOMlabel\\label');
    L.push("\\renewcommand\\label[1]{\\TDOMlabel{#1}\\directlua{tdom_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}}");
    // amsmath routes display-math labels through \ltx@label (captured at
    // package load, before our shim) — intercept that path too
    L.push('\\ifdefined\\ltx@label\\let\\TDOMltxlabel\\ltx@label');
    L.push("\\def\\ltx@label#1{\\TDOMltxlabel{#1}\\directlua{tdom_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}}\\fi");
    L.push('\\let\\TDOMref\\ref');
    L.push("\\renewcommand\\ref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMref{#1}}");
    L.push('\\let\\TDOMpageref\\pageref');
    L.push("\\renewcommand\\pageref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMpageref{#1}}");
    L.push('\\ifdefined\\eqref\\let\\TDOMeqref\\eqref');
    L.push("\\renewcommand\\eqref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMeqref{#1}}\\fi");
    // floats render inline in live mode (exports use the real full compile)
    L.push('\\renewenvironment{figure}[1][]{\\par\\addvspace{\\intextsep}\\def\\@captype{figure}\\noindent\\begin{minipage}{\\textwidth}\\centering}{\\end{minipage}\\par\\addvspace{\\intextsep}}');
    L.push('\\renewenvironment{table}[1][]{\\par\\addvspace{\\intextsep}\\def\\@captype{table}\\noindent\\begin{minipage}{\\textwidth}\\centering}{\\end{minipage}\\par\\addvspace{\\intextsep}}');
    // pre-known labels so forward references resolve in one pass after reboots
    for (const [key, val] of this.labelTable) {
      L.push(`\\global\\@namedef{r@${key}}{{${val}}{1}}`);
    }
    // font warmup: load the common face set into checkpoint 0
    L.push('\\setbox0=\\vbox{\\hsize=\\textwidth The quick brown fox 0123456789');
    L.push('\\textbf{bold} \\textit{italic} \\texttt{mono} \\textsc{Caps}');
    L.push('$a^2+b_i \\alpha\\beta\\gamma \\int_0^\\infty \\sum \\frac{1}{2} \\sqrt{x} \\left(\\frac{A}{B}\\right)$');
    L.push('\\scriptsize tiny \\normalsize}');
    // measure the unicode math twin so OMX substitutions align exactly
    L.push('\\font\\TDOMtwinmath={file:latinmodern-math.otf} at 10pt\\relax');
    L.push("\\directlua{pcall(function() tdom_twin_metrics(font.id('TDOMtwinmath')) end)}");
    L.push('\\makeatother');
    L.push('\\pagestyle{empty}');
    // cancel TeX's 1in shipout origin so render children produce tight pages
    L.push('\\hoffset=-1in');
    L.push('\\voffset=-1in');
    L.push('\\def\\TDOMloop{\\directlua{tdom_wait()}\\TDOMloop}');
    L.push('\\TDOMloop');
    L.push('\\end{document}');
    L.push('');
    return L.join('\n');
  }

  // ------------------------------------------------------------- typeset

  async #jobBlock(idx) {
    const block = this.blocks[idx];
    const ck = this.checkpoints.get(idx);
    if (!ck) throw new Error(`no checkpoint at ${idx} for block ${block.id}`);
    const noindent = this.#noindentFor(idx);
    const body = Buffer.from(block.text, 'utf8');
    const galleyP = this.#await('galley:' + block.id);
    const ckptP = this.#await('ckpt:' + (idx + 1));
    ck.send(`JOB ${block.id} ${idx + 1} ${noindent ? 1 : 0}:${body.length}\n`);
    ck.sendRaw(body);
    const [galley] = await Promise.all([galleyP, ckptP]);
    return galley;
  }

  #adoptGalley(block, galley) {
    block.galley = galley;
    block.galleyHash = fnv1a(JSON.stringify([galley.items, galley.w, galley.h, galley.d]));
    block.stateVec = JSON.stringify(this.counters.map((c) => galley.state?.[c] ?? 0));
    block.gfx = !!galley.gfx;
    block.kind = HEADING_RE.test(block.text)
      ? 'heading'
      : block.gfx
        ? 'graphics'
        : 'paragraph';
    block.units = null;
    for (const [fid, meta] of Object.entries(galley.fonts ?? {})) {
      this.#registerFont(Number(fid), meta);
    }
  }

  #registerFont(fid, meta) {
    if (this.fonts.has(fid)) return;
    const base = path.basename(meta.file || meta.name || '');
    const legacy = !/\.(otf|ttf)$/i.test(base) ? mapLegacyFont(meta.name) : null;
    let familyKey;
    if (legacy) {
      familyKey = 'twin-' + legacy.twin;
      if (!this.fontFiles.has(familyKey)) {
        this.fontFiles.set(familyKey, resolveFont(legacy.twin));
      }
    } else {
      familyKey = 'f-' + fnv1a(meta.file);
      if (!this.fontFiles.has(familyKey)) this.fontFiles.set(familyKey, meta.file);
    }
    this.fonts.set(fid, {
      ...meta,
      family: familyKey,
      remap: legacy?.map ?? null,
      omx: !!legacy?.omx,
    });
  }

  #noindentFor(idx) {
    if (idx === 0) return true;
    return HEADING_RE.test(this.blocks[idx - 1].text);
  }

  // ------------------------------------------------------------- update

  async #update({ editLabel }) {
    const t = new Timer();
    const text = this.store.get(this.file);
    const diagnostics = [];

    // stop any in-flight background rebuild before touching the chain
    this.bgAbort = true;
    await this.bgTask.catch(() => {});
    this.bgAbort = false;

    const bounds = documentBounds(text);
    const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
    const preHash = fnv1a(preamble);
    let rebooted = false;
    if (preHash !== this.preHash) {
      // Structure-changing edit: the honest full-rebuild path.
      await this.#bootRoot();
      this.preHash = preHash;
      rebooted = true;
      for (const b of this.blocks) {
        b.galley = null;
        b.units = null;
      }
    }
    t.lap('boot');

    const oldBlocks = this.blocks;
    const segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
    const diff = diffBlocks(this.blocks, segs, () => this.idSeq++);
    this.blocks = diff.blocks;
    const dirtySource = new Set(diff.dirty);
    t.lap('segment');

    // First index whose checkpoint chain is invalid. A checkpoint at idx
    // holds the state after blocks[0..idx-1], so it survives exactly when
    // that prefix is unchanged — pure deletions/insertions invalidate from
    // the end of the common prefix even when no block is "dirty".
    let commonPrefix = 0;
    while (
      commonPrefix < oldBlocks.length &&
      commonPrefix < this.blocks.length &&
      oldBlocks[commonPrefix].hash === this.blocks[commonPrefix].hash
    ) {
      commonPrefix++;
    }
    let firstDirty = this.blocks.length;
    for (let i = 0; i < this.blocks.length; i++) {
      if (!this.blocks[i].galley || dirtySource.has(this.blocks[i].id)) {
        firstDirty = i;
        break;
      }
    }
    if (oldBlocks.length !== this.blocks.length || diff.removed.length) {
      firstDirty = Math.min(firstDirty, commonPrefix);
    }
    // kill checkpoints beyond the last valid boundary
    for (const [idx, peer] of [...this.checkpoints]) {
      if (idx > firstDirty) {
        peer.send('DIE\n');
        this.checkpoints.delete(idx);
      }
    }

    // ---- foreground typeset: from firstDirty until convergence ---------
    const dirtyBlocks = [];
    const depDirty = [];
    const changedLabels = new Set();
    let typesetCount = 0;
    let forkMs = 0;
    const oldLabels = new Map(this.labelTable);

    let i = firstDirty;
    while (i < this.blocks.length) {
      const block = this.blocks[i];
      const before = { hash: block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
      const t0 = performance.now();
      const galley = await this.#jobBlock(i);
      forkMs += performance.now() - t0;
      typesetCount++;
      const wasClean = before.hadGalley && !dirtySource.has(block.id);
      this.#adoptGalley(block, galley);
      // track label movements
      for (const l of galley.labels ?? []) {
        if (this.labelTable.get(l.k) !== l.v) {
          changedLabels.add(l.k);
          this.labelTable.set(l.k, l.v);
        }
      }
      const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
      if (changed || !wasClean) {
        dirtyBlocks.push(block.id);
        if (wasClean) {
          push2(depDirty, changedLabels.size ? 'label' : 'counter', 'chain', block.id);
        }
      }
      i++;
      if (wasClean && !changed) {
        // convergence: verify no known-affected blocks remain downstream
        const affectedAhead = this.blocks.slice(i).some(
          (b) => !b.galley || (b.galley.refs ?? []).some((k) => changedLabels.has(k))
        );
        if (!affectedAhead) break;
      }
    }
    const fgStop = i;
    t.lap('typeset');

    // labels that vanished entirely
    for (const key of oldLabels.keys()) {
      let stillDefined = false;
      for (const b of this.blocks) {
        if ((b.galley?.labels ?? []).some((l) => l.k === key)) { stillDefined = true; break; }
      }
      if (!stillDefined) {
        this.labelTable.delete(key);
        changedLabels.add(key);
      }
    }
    for (const key of changedLabels) {
      for (const b of this.blocks) {
        if ((b.galley?.refs ?? []).includes(key)) push2(depDirty, 'label', key, b.id);
      }
    }

    // ---- pages, display lists, patches ---------------------------------
    this.#rebuildUnits();
    const stream = [];
    for (const block of this.blocks) stream.push(...(block.units ?? []));
    const rawPages = paginate(stream, this.geometry.textheight);
    const { pages, reused, rebuilt } = reconcilePages(rawPages, this.pages);
    const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
    const prevCount = this.pages.length;
    const patches = [];
    const dirtyPages = [];
    for (const page of pages) {
      if (!page.dl) page.dl = this.#displayList(page);
      if (page.dl.hash !== prevHashes.get(page.number)) {
        dirtyPages.push(page.number);
        patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      }
    }
    if (pages.length < prevCount) patches.push({ type: 'remove-pages', from: pages.length + 1 });
    this.pages = pages;
    t.lap('paginate');

    // ---- async work: rebuild remaining checkpoint chain + gfx renders --
    this.#scheduleBackground(fgStop, dirtyBlocks);
    t.lap('schedule');

    this.rev++;
    return {
      rev: this.rev,
      edit: editLabel,
      backend: this.backendName,
      dirtySourceNodes: [...dirtySource].map((id) => 'src-' + id),
      dirtySemanticNodes: dirtyBlocks.map((id) => 'blk-' + id),
      dirtyDependencies: depDirty,
      dirtyLayoutNodes: dirtyBlocks.map((id) => 'galley-' + id),
      dirtyPages,
      patches,
      stats: {
        ...t.done(),
        blocksTotal: this.blocks.length,
        blocksTypeset: typesetCount,
        blocksReparsed: typesetCount,
        semanticCacheHits: this.blocks.length - typesetCount,
        layoutCacheHits: this.blocks.length - typesetCount,
        layoutCacheMisses: typesetCount,
        typesetMs: Math.round(forkMs * 100) / 100,
        rebooted,
        checkpoints: this.checkpoints.size,
        pagesReused: reused,
        pagesRebuilt: rebuilt,
        pageCount: pages.length,
        macrosChanged: [],
        labelsChanged: [...changedLabels],
        diagnostics: [...diagnostics, ...this.diagnostics.splice(0)],
      },
    };
  }

  #scheduleBackground(fromIdx, dirtyBlocks) {
    // Chain restoration must finish before the next edit is applied (edits
    // await bgTask); graphics renders are fire-and-forget — an edit never
    // waits on pdftocairo.
    this.bgTask = (async () => {
      for (let j = fromIdx; j < this.blocks.length; j++) {
        if (this.bgAbort) return;
        if (this.checkpoints.has(j + 1)) continue;
        const block = this.blocks[j];
        const before = block.galleyHash;
        const galley = await this.#jobBlock(j).catch(() => null);
        if (!galley) return;
        this.#adoptGalley(block, galley);
        if (block.galleyHash !== before) {
          // late-discovered change (rare): patch through the async channel
          this.#asyncRepaginate();
        }
      }
    })();
    for (const block of this.blocks) {
      if (block.gfx && (dirtyBlocks.includes(block.id) || !this.chunks.has(block.id))) {
        this.bgTask
          .then(() => this.#renderBlock(block))
          .catch((err) => {
            this.diagnostics.push(`render ${block.id}: ${err.message}`);
          });
      }
    }
  }

  async #renderBlock(block) {
    const idx = this.blocks.indexOf(block);
    if (idx < 0) return;
    const ck = this.checkpoints.get(idx);
    if (!ck) return;
    const jobdir = path.join(this.workDir, 'render-' + block.id);
    mkdirSync(jobdir, { recursive: true });
    rmSync(path.join(jobdir, 'driver.pdf'), { force: true });
    const body = Buffer.from(block.text, 'utf8');
    const done = this.#await('render:' + block.id, 60_000);
    ck.send(`RENDER ${block.id} ${jobdir} ${body.length}\n`);
    ck.sendRaw(body);
    await done;
    const pdf = path.join(jobdir, 'driver.pdf');
    if (!existsSync(pdf)) throw new Error('render child produced no PDF');
    const svgPath = path.join(jobdir, 'chunk.svg');
    await execFileP('pdftocairo', ['-svg', '-f', '1', '-l', '1', pdf, svgPath], { timeout: 30_000 });
    const svg = readFileSync(svgPath, 'utf8');
    const prev = this.chunks.get(block.id);
    this.chunks.set(block.id, {
      svg,
      wBp: block.galley.w,
      hBp: block.galley.h + block.galley.d,
      v: (prev?.v ?? 0) + 1,
    });
    this.#asyncRepaginate();
  }

  #asyncRepaginate() {
    // rebuild display lists after async galley/chunk arrivals and push
    // patches through the async channel (SSE)
    this.#rebuildUnits();
    const stream = [];
    for (const block of this.blocks) stream.push(...(block.units ?? []));
    const rawPages = paginate(stream, this.geometry.textheight);
    const { pages } = reconcilePages(rawPages, this.pages);
    const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
    const patches = [];
    for (const page of pages) {
      if (!page.dl) page.dl = this.#displayList(page);
      if (page.dl.hash !== prevHashes.get(page.number)) {
        patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      }
    }
    if (pages.length < this.pages.length) {
      patches.push({ type: 'remove-pages', from: pages.length + 1 });
    }
    this.pages = pages;
    if (patches.length && this.onAsyncPatches) {
      this.rev++;
      this.onAsyncPatches({ rev: this.rev, patches });
    }
  }

  // --------------------------------------------------------------- units

  #rebuildUnits() {
    const geo = this.geometry;
    let prevLastBox = null;
    for (const block of this.blocks) {
      const hasChunk = this.chunks.has(block.id);
      const chunkState = block.gfx ? (hasChunk ? 'c' : 'r') : 'n';
      const sig = `${block.galleyHash}|${prevLastBox ? prevLastBox.d : 'x'}|${chunkState}`;
      if (!block.units || block.unitsSig !== sig) {
        block.units = buildUnits(block, geo, prevLastBox, hasChunk);
        block.unitsSig = sig;
      }
      const boxes = (block.galley?.items ?? []).filter((it) => it.k === 'box');
      if (boxes.length) prevLastBox = boxes[boxes.length - 1];
    }
  }

  #displayList(page) {
    const geo = this.geometry;
    const L = 72 + (geo.oddsidemargin ?? 0);
    const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
    const commands = [];
    let gfxOpen = null;
    const flushGfx = () => {
      if (!gfxOpen) return;
      const meta = this.chunks.get(gfxOpen.blockId);
      commands.push({
        op: 'chunk',
        chunk: gfxOpen.blockId,
        x: r2(L),
        y: r2(gfxOpen.top + gfxOpen.clip0),
        w: r2(gfxOpen.w),
        h: r2(gfxOpen.clip1 - gfxOpen.clip0),
        sy: r2(gfxOpen.clip0),
        ch: r2(meta?.hBp ?? gfxOpen.clip1),
        cv: meta?.v ?? 0,
        src: gfxOpen.blockId,
      });
      gfxOpen = null;
    };

    for (const { u, y } of page.units) {
      const baseline = T + y;
      if (u.ln.gfxChunk) {
        const c = u.ln.gfxChunk;
        const unitTop = baseline - u.ln.boxH;
        const chunkTop = unitTop - c.yOff;
        const clip0 = c.yOff;
        const clip1 = c.yOff + u.h;
        if (gfxOpen && gfxOpen.blockId === c.blockId && Math.abs(gfxOpen.top - chunkTop) < 0.05) {
          gfxOpen.clip1 = Math.max(gfxOpen.clip1, clip1);
        } else {
          flushGfx();
          gfxOpen = { blockId: c.blockId, top: chunkTop, clip0, clip1, w: c.w };
        }
        continue;
      }
      flushGfx();
      for (const r of u.ln.runs ?? []) {
        if (r.rule) {
          commands.push({
            op: 'rule',
            x: r2(L + r.x),
            y: r2(baseline + r.dy),
            w: r2(r.w),
            h: r2(r.h),
            color: r.c && r.c !== '#000000' ? r.c : undefined,
            src: u.blockId,
          });
        } else if (r.t) {
          const fmeta = this.fonts.get(r.f);
          const text = fmeta?.remap ? remapText(r.t, fmeta.remap) : r.t;
          // cmex (OMX) glyphs hang below their reference point in TeX's
          // metrics; the unicode twins sit on a normal baseline. Align the
          // ink tops exactly: TeX extents travel with the run, twin extents
          // were measured by the daemon from the actual twin font.
          let dy = r.dy;
          if (fmeta?.omx) {
            const gh = r.gh ?? 0;
            const gd = r.gd ?? 0;
            const cp = text.codePointAt(0);
            const tm = this.twinMetrics?.[cp];
            if (tm) {
              dy = r.dy - gh + tm[0] * (r.s / 10);
            } else {
              dy = r.dy - gh + 0.78 * (gh + gd);
            }
          }
          commands.push({
            op: 'glyphs',
            fam: fmeta?.family ?? 'f-unknown',
            size: r.s,
            x: r2(L + r.x),
            y: r2(baseline + dy),
            text,
            color: r.c && r.c !== '#000000' ? r.c : undefined,
            src: u.blockId,
          });
        }
      }
    }
    flushGfx();
    commands.push({
      op: 'folio',
      x: r2(geo.paperwidth / 2),
      y: r2(geo.paperheight - Math.max(36, (geo.paperheight - T - geo.textheight) / 2)),
      text: String(page.number),
    });
    const dl = { page: page.number, commands };
    dl.hash = fnv1a(JSON.stringify(commands));
    return dl;
  }
}

// ------------------------------------------------------------------ Peer

class Peer {
  constructor(sock, engine) {
    this.sock = sock;
    this.engine = engine;
    this.role = '?';
    this.pid = 0;
    this.buf = Buffer.alloc(0);
    this.pendingHeader = null; // { kind, id, len }
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.#drain();
    });
    sock.on('error', () => {});
  }

  send(line) {
    try { this.sock.write(line); } catch { /* peer gone */ }
  }

  sendRaw(buf) {
    try { this.sock.write(buf); } catch { /* peer gone */ }
  }

  #drain() {
    while (true) {
      if (this.pendingHeader) {
        const { kind, id, len } = this.pendingHeader;
        if (this.buf.length < len) return;
        const payload = this.buf.subarray(0, len).toString('utf8');
        this.buf = this.buf.subarray(len);
        this.pendingHeader = null;
        let json = null;
        try {
          json = JSON.parse(payload);
        } catch (err) {
          this.engine.diagnostics.push(`bad ${kind} payload from pid ${this.pid}: ${err.message}`);
        }
        if (json) this.engine._onMessage(this, { kind, id, json });
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8').trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line) continue;
      const parts = line.split(/\s+/);
      switch (parts[0]) {
        case 'HELLO':
          this.engine._onMessage(this, {
            kind: 'HELLO',
            role: parts[1],
            idx: Number(parts[2]),
            pid: Number(parts[3]),
          });
          break;
        case 'GEO':
          this.pendingHeader = { kind: 'GEO', id: null, len: Number(parts[1]) };
          break;
        case 'TWIN':
          this.pendingHeader = { kind: 'TWIN', id: null, len: Number(parts[1]) };
          break;
        case 'GALLEY':
          this.pendingHeader = { kind: 'GALLEY', id: parts[1], len: Number(parts[2]) };
          break;
        case 'CKPT':
          this.engine._onMessage(this, { kind: 'CKPT', idx: Number(parts[1]), pid: Number(parts[2]) });
          break;
        case 'DONE':
          this.engine._onMessage(this, { kind: 'DONE', id: parts[1] });
          break;
        case 'FORKED':
        case 'PONG':
          break;
        default:
          break;
      }
    }
  }
}

// ------------------------------------------------------------- helpers

/** galley items -> pagination units (same contract as the other engines). */
function buildUnits(block, geo, prevLastBox, hasChunk) {
  const items = block.galley?.items ?? [];
  const units = [];
  let pending = 0;
  let li = 0;
  let first = true;
  let lastUnit = null;
  let yOff = 0;
  for (const it of items) {
    if (it.k === 'glue' || it.k === 'kern') {
      pending += it.a ?? 0;
      yOff += it.a ?? 0;
      continue;
    }
    if (it.k === 'pen') {
      if ((it.v ?? 0) >= 10000 && lastUnit) lastUnit.keepWithNext = true;
      continue;
    }
    let pre = pending;
    if (first) {
      if (prevLastBox) {
        const inter = Math.max(
          geo.lineskip ?? 1,
          (geo.baselineskip ?? 14.5) - (prevLastBox.d ?? 0) - (it.h ?? 0)
        );
        pre += inter + (geo.parskip ?? 0);
      }
      first = false;
    }
    const unit = {
      blockId: block.id,
      li: li++,
      h: (it.h ?? 0) + (it.d ?? 0),
      pre,
      post: 0,
      keepWithNext: false,
      ln: {
        descent: it.d ?? 0,
        boxH: it.h ?? 0,
        runs: it.runs ?? [],
        gfxChunk:
          block.gfx && hasChunk
            ? { blockId: block.id, yOff, w: block.galley.w }
            : null,
      },
    };
    units.push(unit);
    lastUnit = unit;
    pending = 0;
    yOff += (it.h ?? 0) + (it.d ?? 0);
  }
  if (lastUnit) lastUnit.post += pending;
  if (HEADING_RE.test(block.text) && lastUnit) lastUnit.keepWithNext = true;
  return units;
}

function scanCounterDefs(preamble) {
  const out = [];
  const re = /\\newtheorem\*?\{([^}]+)\}|\\newcounter\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(preamble))) out.push(m[1] ?? m[2]);
  return out;
}

function resolveFont(name) {
  try {
    return execFileSync('kpsewhich', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function luaStr(s) {
  return s.replace(/\\/g, '/').replace(/'/g, "\\'");
}

function push2(list, kind, key, blockId) {
  let entry = list.find((e) => e.kind === kind && e.key === key);
  if (!entry) {
    entry = { kind, key, affected: [] };
    list.push(entry);
  }
  if (!entry.affected.includes('blk-' + blockId)) entry.affected.push('blk-' + blockId);
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
