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
import { buildPages, reconcile } from './pagebuilder.js';
import { mapLegacyFont, remapText } from './mathmap.js';
import { statSync, watch } from 'node:fs';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

const BASE_COUNTERS = [
  'part', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];
const HEADING_RE = /^\s*\\(section|subsection|subsubsection|paragraph)\b/;
const JOB_TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

export class CheckpointEngine {
  constructor({ workDir, docDir }) {
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
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
    this.chunks = new Map(); // chunkKey -> {svg, wBp, hBp, v} exact renders
    this.bgAbort = false;
    this.bgTask = Promise.resolve();
    this.onAsyncPatches = null; // callback(report-ish) for gfx swaps
    this.onExternalChange = null; // callback when an \input file changes
    this.backendName = 'checkpoint';
    this.diagnostics = [];
    this.tocHash = null;
    this.includes = new Map(); // path -> {mtime, text}
    this.watchers = new Map(); // path -> FSWatcher
    this.maxCheckpoints = 64;
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
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.watchers.clear();
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
      for (const d of page.draw ?? []) {
        const bid = d.u?.blockId;
        if (!bid) continue;
        if (!blockPages.has(bid)) blockPages.set(bid, []);
        const arr = blockPages.get(bid);
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
      // fail fast: if the process carrying the in-flight job dies (TeX
      // emergency stop on a broken block, missing file, ...), reject its
      // waiters immediately instead of running out the 30s timeout
      const job = this.currentJob;
      if (job && (peer === job.parent || (job.pid && peer.pid === job.pid))) {
        const err = new Error('typesetting process died (TeX error in this block?)');
        this._reject(job.galleyKey, err);
        this._reject(job.ckptKey, err);
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

  _reject(key, err) {
    const w = this.waiters.get(key);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(key);
      w.reject(err);
    }
  }

  // message dispatch from Peer
  _onMessage(peer, msg) {
    switch (msg.kind) {
      case 'HELLO':
        peer.role = msg.role;
        peer.pid = msg.pid;
        peer.idxAnnounced = msg.idx;
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
      case 'FORKED':
        if (this.currentJob && this.currentJob.galleyKey === 'galley:' + msg.id) {
          this.currentJob.pid = msg.pid;
        }
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

    rmSync(path.join(this.workDir, 'driver.pdf'), { force: true });
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
    const rootRef = this.root;
    this.root.on('exit', () => {
      if (this.root !== rootRef) return; // a superseded root dying is expected
      this.rootLog = rootLog;
      // a dead root can never announce ckpt:0 — fail the boot immediately
      // (a broken preamble in nonstopmode still prompts on missing files
      // and emergency-stops on EOF)
      const err = new Error('lualatex exited during preamble: ' + texErrorFrom(rootLog));
      this._reject('ckpt:0', err);
      this._reject('geo', err);
      this.checkpoints.clear();
    });
    this.rootLogRef = () => rootLog;

    await Promise.all([ckptReady, geoReady]).catch((err) => {
      throw new Error(`preamble build failed — ${texErrorFrom(rootLog) || err.message}`);
    });
    // hyperref (and friends) write PDF objects during \begin{document},
    // which opens the shared output file at the root — checkpoint children
    // can then no longer ship their own tight pages. Fall back to isolated
    // per-block compiles for the exact-render tier in that case.
    this.pdfOpenedAtRoot = existsSync(path.join(this.workDir, 'driver.pdf'));
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
    // \cite: record dependencies on bibliography keys
    L.push('\\let\\TDOMcite\\cite');
    L.push("\\renewcommand\\cite[2][]{\\directlua{tdom_cites('\\luaescapestring{#2}')}" +
      '\\ifx\\relax#1\\relax\\TDOMcite{#2}\\else\\TDOMcite[#1]{#2}\\fi}');
    // float capture: environments typeset into a box that the daemon walks;
    // an anchor \special marks the declaration point for the page builder
    L.push('\\newbox\\TDOMfloatbox');
    L.push('\\directlua{TDOM_FLOATBOX=\\number\\TDOMfloatbox}');
    L.push('\\newcount\\TDOMfloatn');
    for (const env of ['figure', 'table']) {
      L.push(
        `\\renewenvironment{${env}}[1][tbp]{\\gdef\\TDOMfp{#1}\\def\\@captype{${env}}` +
          '\\global\\setbox\\TDOMfloatbox\\vbox\\bgroup\\hsize\\textwidth\\centering}' +
          `{\\egroup\\global\\advance\\TDOMfloatn\\@ne\\special{tdomfloat:\\number\\TDOMfloatn}` +
          `\\directlua{tdom_float(\\number\\TDOMfloatn,'\\TDOMfp','${env}')}\\ignorespaces}`
      );
    }
    // \tableofcontents reads the toc the orchestrator maintains; never write
    L.push('\\renewcommand\\@starttoc[1]{{\\makeatletter\\@input{\\jobname.#1}}}');
    // live bibliography: define \b@<key> as \bibitem runs so \cite resolves
    L.push('\\ifdefined\\@bibitem\\let\\TDOMbibitem\\@bibitem');
    L.push("\\def\\@bibitem#1{\\TDOMbibitem{#1}\\directlua{tdom_bib('\\luaescapestring{#1}','\\luaescapestring{\\the\\value{enumiv}}')}}\\fi");
    L.push('\\ifdefined\\@lbibitem\\let\\TDOMlbibitem\\@lbibitem');
    L.push("\\def\\@lbibitem[#1]#2{\\TDOMlbibitem[#1]{#2}\\directlua{tdom_bib('\\luaescapestring{#2}','\\luaescapestring{#1}')}}\\fi");
    // page-builder geometry (skips are read as their natural widths)
    L.push('\\directlua{tdom_dim(\'footinsskip\',\\number\\dimexpr\\skip\\footins\\relax)}');
    L.push('\\directlua{tdom_dim(\'floatsep\',\\number\\dimexpr\\floatsep\\relax)}');
    L.push('\\directlua{tdom_dim(\'textfloatsep\',\\number\\dimexpr\\textfloatsep\\relax)}');
    L.push('\\directlua{tdom_dim(\'intextsep\',\\number\\dimexpr\\intextsep\\relax)}');
    L.push('\\directlua{tdom_num(\'topfraction\',\\topfraction)}');
    L.push('\\directlua{tdom_num(\'bottomfraction\',\\bottomfraction)}');
    L.push('\\directlua{tdom_geo()}');
    // pre-known labels so forward references resolve in one pass after reboots
    for (const [key, val] of this.labelTable) {
      if (key.startsWith('cite:')) {
        L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
      } else {
        L.push(`\\global\\@namedef{r@${key}}{{${val}}{1}}`);
      }
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
    // Labels are defined in descendant lineages only; when resuming from an
    // ancestor snapshot, forward-referenced values must be injected so this
    // block sees the document-wide truth.
    const defs = [];
    for (const key of block.galley?.refs ?? []) {
      const val = this.labelTable.get(key);
      const cs = key.startsWith('cite:') ? `b@${key.slice(5)}` : `r@${key}`;
      if (val === undefined) {
        // vanished label: neutralize stale definitions in this lineage
        defs.push(`\\global\\expandafter\\let\\csname ${cs}\\endcsname\\relax`);
      } else if (key.startsWith('cite:')) {
        defs.push(`\\global\\@namedef{${cs}}{${val}}`);
      } else {
        defs.push(`\\global\\@namedef{${cs}}{{${val}}{1}}`);
      }
    }
    const prelude = defs.length
      ? `\\makeatletter ${defs.join(' ')}\\makeatother\n`
      : '';
    const body = Buffer.from(prelude + block.text, 'utf8');
    const galleyKey = 'galley:' + block.id;
    const ckptKey = 'ckpt:' + (idx + 1);
    const galleyP = this.#await(galleyKey);
    const ckptP = this.#await(ckptKey);
    this.currentJob = { galleyKey, ckptKey, parent: ck, ckptIdx: idx + 1 };
    try {
      ck.send(`JOB ${block.id} ${idx + 1} ${noindent ? 1 : 0}:${body.length}\n`);
      ck.sendRaw(body);
      const [galley] = await Promise.all([galleyP, ckptP]);
      this.#retireOffGrid(idx);
      return galley;
    } finally {
      this.currentJob = null;
    }
  }

  // Sparse checkpoints: for large documents only every grid-th boundary
  // stays resident. Edits resume from the nearest kept snapshot and simply
  // retypeset a few extra clean blocks (~3ms each).
  #ckptGrid() {
    return Math.max(1, Math.ceil((this.blocks.length + 1) / this.maxCheckpoints));
  }

  #retireOffGrid(idx) {
    const grid = this.#ckptGrid();
    if (grid <= 1 || idx === 0 || idx % grid === 0) return;
    if (!this.checkpoints.has(idx + 1)) return; // successor must exist first
    const peer = this.checkpoints.get(idx);
    if (peer) {
      peer.send('DIE\n');
      this.checkpoints.delete(idx);
    }
  }

  #nearestCheckpoint(idx) {
    let best = 0;
    for (const k of this.checkpoints.keys()) {
      if (k <= idx && k > best) best = k;
    }
    return best;
  }

  #adoptGalley(block, galley) {
    block.galley = galley;
    block.galleyHash = fnv1a(
      JSON.stringify([galley.items, galley.floats, galley.w, galley.h, galley.d])
    );
    block.stateVec = JSON.stringify(this.counters.map((c) => galley.state?.[c] ?? 0));
    block.gfx = !!galley.gfx;
    block.needsRender = block.gfx || (galley.floats ?? []).some((f) => f.gfx);
    block.consumesToc = /\\tableofcontents\b/.test(block.text);
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

  async #update({ editLabel, retry = false }) {
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
    let segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
    segs = this.#expandIncludes(segs, 0);
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

    // ---- foreground typeset: resume from the nearest kept snapshot -----
    // Any failure in the typeset phase (dead checkpoint, TeX emergency
    // stop, protocol timeout) triggers ONE full rebuild retry; if that
    // also fails the error surfaces to the client while the last good
    // pages keep being served.
    try {
    const dirtyBlocks = [];
    const depDirty = [];
    const changedLabels = new Set();
    let typesetCount = 0;
    let forkMs = 0;
    const oldLabels = new Map(this.labelTable);

    let i = this.#nearestCheckpoint(Math.min(firstDirty, this.blocks.length));
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
      if (wasClean && !changed && i > firstDirty) {
        // convergence: verify no known-affected blocks remain downstream
        const affectedAhead = this.blocks.slice(i).some(
          (b) => !b.galley || (b.galley.refs ?? []).some((k) => changedLabels.has(k))
        );
        if (!affectedAhead) break;
      }
    }
    const fgStop = i;

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

    // Backward references: a label defined LATER in the chain (new figure,
    // renamed equation...) can be referenced by EARLIER blocks, which the
    // forward pass never revisits. Retypeset those ref-users explicitly.
    if (changedLabels.size) {
      for (let c = 0; c < this.blocks.length; c++) {
        const block = this.blocks[c];
        const hit = (block.galley?.refs ?? []).some(
          (k) => changedLabels.has(k) && !resolvedInGalley(block, k, this.labelTable)
        );
        if (!hit) continue;
        const from = this.#nearestCheckpoint(c);
        for (let j = from; j <= c && j < this.blocks.length; j++) {
          const g = await this.#jobBlock(j).catch(() => null);
          if (!g) break;
          const beforeHash = this.blocks[j].galleyHash;
          this.#adoptGalley(this.blocks[j], g);
          typesetCount++;
          if (j === c && this.blocks[j].galleyHash !== beforeHash) {
            dirtyBlocks.push(block.id);
            for (const k of block.galley.refs ?? []) {
              if (changedLabels.has(k)) push2(depDirty, 'label', k, block.id);
            }
          }
        }
      }
    }
    t.lap('typeset');

    for (const key of changedLabels) {
      for (const b of this.blocks) {
        if ((b.galley?.refs ?? []).includes(key)) push2(depDirty, 'label', key, b.id);
      }
    }

    // ---- live table of contents -----------------------------------------
    // Provisional pagination gives page numbers; if the toc data moved,
    // retypeset the \tableofcontents blocks with the fresh toc file.
    // Fixed point: the toc block's own height shifts page numbers, which
    // shift the toc — iterate like latex reruns would, but per block.
    for (let pass = 0; pass < 3; pass++) {
      const prov = this.#paginateNow();
      const toc = this.#computeToc(prov);
      if (toc.hash === this.tocHash) break;
      this.tocHash = toc.hash;
      writeFileSync(path.join(this.workDir, 'driver.toc'), toc.content);
      let anyConsumer = false;
      for (let c = 0; c < this.blocks.length; c++) {
        const block = this.blocks[c];
        if (!block.consumesToc) continue;
        anyConsumer = true;
        const from = this.#nearestCheckpoint(c);
        for (let j = from; j <= c && j < this.blocks.length; j++) {
          const g = await this.#jobBlock(j).catch(() => null);
          if (!g) break;
          const beforeHash = this.blocks[j].galleyHash;
          this.#adoptGalley(this.blocks[j], g);
          typesetCount++;
          if (j === c && this.blocks[j].galleyHash !== beforeHash) {
            dirtyBlocks.push(block.id);
            push2(depDirty, 'toc', 'contents', block.id);
          }
        }
      }
      if (!anyConsumer) break;
    }
    t.lap('toc');
    this._typesetResult = { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop };
    } catch (err) {
      if (!retry) {
        this.diagnostics.push('typeset phase failed (' + err.message + ') — full rebuild');
        this.preHash = null; // force a root reboot on the retry pass
        for (const peer of this.peers) peer.send('DIE\n');
        this.checkpoints.clear();
        return this.#update({ editLabel, retry: true });
      }
      throw err;
    }
    const { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop } = this._typesetResult;

    // ---- pages, display lists, patches ---------------------------------
    const pagesRaw = this.#paginateNow();
    const { pages, reused, rebuilt } = reconcile(pagesRaw, this.pages);
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
      const missingChunk =
        (block.gfx && !this.chunks.has(block.id)) ||
        (block.galley?.floats ?? []).some((f) => f.gfx && !this.chunks.has(block.id + '#' + f.n));
      if (block.needsRender && (dirtyBlocks.includes(block.id) || missingChunk)) {
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
    if (this.pdfOpenedAtRoot) return this.#renderIsolated(block, idx);
    const ck = this.checkpoints.get(idx);
    if (!ck) return;
    // one render per (block, content); stale results are discarded so a
    // fast typist never sees an outdated exact image over live glyphs
    const forGalley = block.galleyHash;
    const inflightKey = block.id + ':' + forGalley;
    this.rendering ??= new Set();
    if (this.rendering.has(inflightKey)) return;
    this.rendering.add(inflightKey);
    try {
    const jobdir = path.join(this.workDir, `render-${block.id}-${forGalley}`);
    mkdirSync(jobdir, { recursive: true });
    rmSync(path.join(jobdir, 'driver.pdf'), { force: true });
    const body = Buffer.from(block.text, 'utf8');
    const done = this.#await('render:' + block.id, 60_000);
    ck.send(`RENDER ${block.id} ${jobdir} ${body.length}\n`);
    ck.sendRaw(body);
    await done;
    const pdf = path.join(jobdir, 'driver.pdf');
    if (!existsSync(pdf)) throw new Error('render child produced no PDF');
    // page 1 = the block galley; pages 2..N = its float boxes in order
    const targets = [];
    if (block.gfx) {
      targets.push({ key: block.id, page: 1, w: block.galley.w, h: block.galley.h + block.galley.d });
    }
    (block.galley.floats ?? []).forEach((f, i) => {
      if (f.gfx) {
        targets.push({ key: block.id + '#' + f.n, page: 2 + i, w: f.w, h: (f.h ?? 0) + (f.d ?? 0) });
      }
    });
    for (const tgt of targets) {
      const svgPath = path.join(jobdir, `chunk-${tgt.page}.svg`);
      await execFileP(
        'pdftocairo',
        ['-svg', '-f', String(tgt.page), '-l', String(tgt.page), pdf, svgPath],
        { timeout: 30_000 }
      );
      const svg = readFileSync(svgPath, 'utf8');
      const prev = this.chunks.get(tgt.key);
      this.chunks.set(tgt.key, {
        svg,
        wBp: tgt.w,
        hBp: tgt.h,
        v: (prev?.v ?? 0) + 1,
        forGalley,
      });
    }
    if (block.galleyHash === forGalley) this.#asyncRepaginate();
    } finally {
      this.rendering.delete(inflightKey);
    }
  }

  /**
   * Exact render via a standalone lualatex run — used when the resident
   * tree cannot ship pages (hyperref opened the PDF at boot). Slower
   * (full preamble per render) but pixel-exact all the same.
   */
  async #renderIsolated(block, idx) {
    if ((block.galley?.floats ?? []).length) {
      this.diagnostics.push(
        `render ${block.id}: float chunks unavailable under hyperref-style preambles (instant glyphs kept)`
      );
      return;
    }
    const forGalley = block.galleyHash;
    const inflightKey = 'iso:' + block.id + ':' + forGalley;
    this.rendering ??= new Set();
    if (this.rendering.has(inflightKey)) return;
    this.rendering.add(inflightKey);
    try {
      // entry counters = fold of state deltas over the preceding chain
      const entry = Object.fromEntries(this.counters.map((c) => [c, 0]));
      for (let j = 0; j < idx; j++) {
        for (const [k, v] of Object.entries(this.blocks[j].stateDelta ?? {})) {
          entry[k] = (entry[k] ?? 0) + v;
        }
      }
      const text = this.store.get(this.file);
      const bounds = documentBounds(text);
      const L = [];
      L.push(text.slice(bounds.preamble.start, bounds.preamble.end).trimEnd());
      L.push('\\begin{document}');
      L.push('\\makeatletter\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in');
      for (const [key, val] of this.labelTable) {
        if (key.startsWith('cite:')) L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
        else L.push(`\\global\\@namedef{r@${key}}{{${val}}{1}}`);
      }
      for (const [name, val] of Object.entries(entry)) {
        L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${val}}\\fi`);
      }
      L.push('\\makeatother');
      L.push('\\setbox0=\\vbox{\\hsize=\\textwidth');
      if (this.#noindentFor(idx)) L.push('\\noindent');
      L.push(block.text.trimEnd());
      L.push('\\par}');
      L.push('\\directlua{local b=tex.box[0] tex.pagewidth=math.max(b.width or 0,65536) tex.pageheight=math.max((b.height or 0)+(b.depth or 0),65536)}');
      L.push('\\shipout\\box0');
      L.push('\\end{document}');
      const jobdir = path.join(this.workDir, `render-${block.id}-${forGalley}`);
      mkdirSync(jobdir, { recursive: true });
      rmSync(path.join(jobdir, 'iso.pdf'), { force: true });
      writeFileSync(path.join(jobdir, 'iso.tex'), L.join('\n') + '\n');
      await execFileP('lualatex', ['-interaction=nonstopmode', 'iso.tex'], {
        cwd: jobdir,
        timeout: 90_000,
      }).catch(() => {});
      const pdf = path.join(jobdir, 'iso.pdf');
      if (!existsSync(pdf)) throw new Error('isolated render produced no PDF');
      const svgPath = path.join(jobdir, 'iso.svg');
      await execFileP('pdftocairo', ['-svg', '-f', '1', '-l', '1', pdf, svgPath], { timeout: 30_000 });
      const svg = readFileSync(svgPath, 'utf8');
      const prev = this.chunks.get(block.id);
      this.chunks.set(block.id, {
        svg,
        wBp: block.galley.w,
        hBp: block.galley.h + block.galley.d,
        v: (prev?.v ?? 0) + 1,
        forGalley,
      });
      if (block.galleyHash === forGalley) this.#asyncRepaginate();
      rmSync(jobdir, { recursive: true, force: true });
    } finally {
      this.rendering.delete(inflightKey);
    }
  }

  #asyncRepaginate() {
    // rebuild display lists after async galley/chunk arrivals and push
    // patches through the async channel (SSE)
    const rawPages = this.#paginateNow();
    const { pages } = reconcile(rawPages, this.pages);
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

  #paginateNow() {
    this.#rebuildUnits();
    const stream = [];
    for (const block of this.blocks) stream.push(...(block.units ?? []));
    return buildPages(stream, this.geometry);
  }

  #rebuildUnits() {
    const geo = this.geometry;
    let prevLastBox = null;
    for (const block of this.blocks) {
      const bc = this.chunks.get(block.id);
      const hasChunk = !!bc && bc.forGalley === block.galleyHash;
      const floatVs = (block.galley?.floats ?? [])
        .map((f) => {
          const fc = this.chunks.get(block.id + '#' + f.n);
          return fc && fc.forGalley === block.galleyHash ? fc.v : 0;
        })
        .join(',');
      const sig = `${block.galleyHash}|${prevLastBox ? prevLastBox.d : 'x'}|${
        hasChunk ? bc.v : 0
      }|${floatVs}`;
      if (!block.units || block.unitsSig !== sig) {
        block.units = buildUnits(block, geo, prevLastBox, hasChunk, this.chunks);
        block.unitsSig = sig;
      }
      const boxes = (block.galley?.items ?? []).filter((it) => it.k === 'box');
      if (boxes.length) prevLastBox = boxes[boxes.length - 1];
    }
  }

  // ----------------------------------------------------- toc / includes

  #computeToc(pages) {
    const blockPage = new Map();
    for (const page of pages) {
      for (const d of page.draw ?? []) {
        const bid = d.u?.blockId;
        if (bid && !blockPage.has(bid)) blockPage.set(bid, page.number);
      }
    }
    const secIdx = this.counters.indexOf('section');
    const subIdx = this.counters.indexOf('subsection');
    const subsubIdx = this.counters.indexOf('subsubsection');
    const lines = [];
    for (const block of this.blocks) {
      const m = block.text.match(/^\s*\\(section|subsection|subsubsection)(\*?)\s*\{/);
      if (!m || m[2] === '*' || !block.stateVec) continue;
      const vec = JSON.parse(block.stateVec);
      const title = extractBraced(block.text, block.text.indexOf('{', m.index));
      const page = blockPage.get(block.id) ?? 1;
      let num;
      if (m[1] === 'section') num = `${vec[secIdx]}`;
      else if (m[1] === 'subsection') num = `${vec[secIdx]}.${vec[subIdx]}`;
      else num = `${vec[secIdx]}.${vec[subIdx]}.${vec[subsubIdx]}`;
      // 4th (destination) argument required by LaTeX 2020-10 and later
      lines.push(`\\contentsline {${m[1]}}{\\numberline {${num}}${title}}{${page}}{}%`);
    }
    const content = lines.join('\n') + '\n';
    return { hash: fnv1a(content), content };
  }

  #expandIncludes(segs, depth) {
    if (depth > 3) return segs;
    const out = [];
    for (const seg of segs) {
      const m = seg.text.match(/^\s*\\(input|include)\s*\{([^}]+)\}\s*$/);
      if (!m) {
        out.push(seg);
        continue;
      }
      let rel = m[2];
      if (!/\.tex$/i.test(rel)) rel += '.tex';
      const full = path.resolve(this.docDir ?? this.workDir, rel);
      let text = null;
      try {
        const st = statSync(full);
        const cached = this.includes.get(full);
        text = cached && cached.mtime === st.mtimeMs ? cached.text : readFileSync(full, 'utf8');
        this.includes.set(full, { mtime: st.mtimeMs, text });
        this.#watchInclude(full);
      } catch {
        this.diagnostics.push(`\\input file not found: ${rel} (typeset literally)`);
        out.push(seg);
        continue;
      }
      const subs = this.#expandIncludes(segmentBody(text, 0), depth + 1);
      for (const s of subs) out.push({ ...s, file: full, hash: fnv1a(full + '|' + s.text) });
    }
    return out;
  }

  #watchInclude(full) {
    if (this.watchers.has(full)) return;
    try {
      let timer = null;
      const w = watch(full, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.onExternalChange?.(full), 120);
      });
      this.watchers.set(full, w);
    } catch {
      /* watching is best-effort */
    }
  }

  async refresh() {
    return this.#update({ editLabel: 'external-include' });
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

    for (const entry of page.draw ?? []) {
      if (entry.rule) {
        flushGfx();
        commands.push({
          op: 'rule',
          x: r2(L),
          y: r2(T + entry.y),
          w: r2(entry.rule.w),
          h: r2(entry.rule.h),
          src: '_footrule',
        });
        continue;
      }
      const u = entry.u;
      const baseline = T + entry.y;
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
          this.engine._onMessage(this, { kind: 'FORKED', id: parts[1], pid: Number(parts[2]) });
          break;
        case 'PONG':
          break;
        default:
          break;
      }
    }
  }
}

// ------------------------------------------------------------- helpers

/**
 * galley items -> pagination units. Footnote inserts attach to their line's
 * unit; float anchors become float objects carrying their own mini-galleys.
 */
function buildUnits(block, geo, prevLastBox, hasChunk, chunks) {
  const items = block.galley?.items ?? [];
  const floats = block.galley?.floats ?? [];
  const units = [];
  let pending = 0;
  let li = 0;
  let first = true;
  let lastUnit = null;
  let yOff = 0;
  const pendingIns = [];

  const makeFloat = (n) => {
    const f = floats.find((x) => x.n === n);
    if (!f) return null;
    const chunkKey = block.id + '#' + f.n;
    const fc = chunks.get(chunkKey);
    const chunkRef =
      f.gfx && fc && fc.forGalley === block.galleyHash ? { key: chunkKey, w: f.w } : null;
    return {
      id: chunkKey,
      placement: f.placement,
      type: f.type,
      w: f.w,
      h: (f.h ?? 0) + (f.d ?? 0),
      gfx: f.gfx,
      blockId: block.id,
      units: miniUnits(f.items, block.id, chunkRef),
    };
  };

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
    if (it.k === 'ins') {
      const ins = { units: miniUnits(it.items, block.id, null), h: it.h ?? 0 };
      if (lastUnit) (lastUnit.inserts ??= []).push(ins);
      else pendingIns.push(ins);
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
        // height above the baseline only: pagination stores the baseline as
        // top + boxH, and the display list recovers the top from it.
        boxH: it.h ?? 0,
        runs: it.runs ?? [],
        gfxChunk:
          block.gfx && hasChunk
            ? { blockId: block.id, yOff, w: block.galley.w }
            : null,
      },
    };
    if (pendingIns.length) unit.inserts = pendingIns.splice(0);
    if (it.fm) {
      for (const n of it.fm) {
        const f = makeFloat(n);
        if (f) (unit.floats ??= []).push(f);
      }
    }
    units.push(unit);
    lastUnit = unit;
    pending = 0;
    yOff += (it.h ?? 0) + (it.d ?? 0);
  }
  if (lastUnit) {
    lastUnit.post += pending;
    if (pendingIns.length) (lastUnit.inserts ??= []).push(...pendingIns);
  }
  // float-only blocks: anchor floats to a zero-height carrier unit
  if (!units.length && floats.length) {
    units.push({
      blockId: block.id,
      li: 0,
      h: 0.01,
      pre: 0,
      post: 0,
      keepWithNext: false,
      ln: { descent: 0, boxH: 0.01, runs: [], gfxChunk: null },
      floats: floats.map((f) => makeFloat(f.n)).filter(Boolean),
    });
  }
  if (HEADING_RE.test(block.text) && lastUnit) lastUnit.keepWithNext = true;
  return units;
}

/** Convert a captured mini-galley (float body, footnote text) to draw units. */
function miniUnits(items, blockId, chunkRef) {
  const units = [];
  let y = 0;
  for (const it of items ?? []) {
    if (it.k === 'glue' || it.k === 'kern') {
      y += it.a ?? 0;
      continue;
    }
    if (it.k !== 'box') continue;
    units.push({
      blockId,
      h: (it.h ?? 0) + (it.d ?? 0),
      yRel: y + (it.h ?? 0), // baseline relative to the mini-galley top
      ln: {
        descent: it.d ?? 0,
        boxH: it.h ?? 0,
        runs: it.runs ?? [],
        gfxChunk: chunkRef ? { blockId: chunkRef.key, yOff: y, w: chunkRef.w } : null,
      },
    });
    y += (it.h ?? 0) + (it.d ?? 0);
  }
  return units;
}

/** Extract a balanced {...} group's contents starting at an opening brace. */
function extractBraced(text, open) {
  if (open < 0 || text[open] !== '{') return '';
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '{' && text[i - 1] !== '\\') depth++;
    else if (c === '}' && text[i - 1] !== '\\') depth--;
    if (depth === 0) break;
    i++;
  }
  return text.slice(open + 1, i);
}

/**
 * True when the block's galley plausibly already reflects the label's
 * current value (cheap check: the rendered text contains the value and no
 * unresolved ?? marker for it).
 */
function resolvedInGalley(block, key, labelTable) {
  const val = labelTable.get(key);
  if (val === undefined) return false;
  if (block.__galleyText === undefined || block.__galleyTextHash !== block.galleyHash) {
    const parts = [];
    const visit = (items) => {
      for (const it of items ?? []) {
        for (const r of it.runs ?? []) if (r.t) parts.push(r.t);
        if (it.items) visit(it.items);
      }
    };
    visit(block.galley?.items);
    for (const f of block.galley?.floats ?? []) visit(f.items);
    block.__galleyText = parts.join(' ');
    block.__galleyTextHash = block.galleyHash;
  }
  if (block.__galleyText.includes('??') || block.__galleyText.includes('[?]')) return false;
  return block.__galleyText.includes(String(val));
}

/** Pull the first TeX error lines out of a lualatex log/stdout capture. */
function texErrorFrom(log) {
  const lines = String(log || '').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('! '));
  if (idx < 0) return '';
  return lines.slice(idx, idx + 2).join(' ').trim();
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
