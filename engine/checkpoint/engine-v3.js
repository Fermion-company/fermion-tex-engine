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
import { buildPages, reconcile, parsePlacement } from './pagebuilder.js';
import { mapLegacyFont, remapText } from './mathmap.js';
import { statSync, watch } from 'node:fs';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

const BASE_COUNTERS = [
  'part', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];
const HEADING_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\b/;
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
    this.fullPagePreviewActive = false;
    this.fullPagePreviewSeq = 0;
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
      for (const cmd of page.dl?.commands ?? []) {
        if (cmd.op !== 'hitbox' || !cmd.src) continue;
        if (!blockPages.has(cmd.src)) blockPages.set(cmd.src, []);
        const arr = blockPages.get(cmd.src);
        if (arr[arr.length - 1] !== page.number) arr.push(page.number);
      }
    }
    return {
      rev: this.rev,
      backend: this.backendName,
      pageCount: this.pages.length,
      checkpoints: [...this.checkpoints.keys()].sort((a, b) => a - b),
      blocks: this.blocks.map((b, i) => {
        const floatGfxChunks = (b.galley?.floats ?? []).filter((f) => f.gfx).map((f) => `${b.id}#${f.n}`);
        const gfxChunks = [...(b.gfx ? [b.id] : []), ...floatGfxChunks];
        const type = b.kind ?? (HEADING_RE.test(b.text) ? 'heading' : 'block');
        return {
          id: b.id,
          index: i,
          type,
          gfx: gfxChunks.length > 0,
          gfxChunks,
          source: {
            file: this.file,
            start: this.store.position(this.file, b.start),
            end: this.store.position(this.file, b.end),
          },
          labels: (b.galley?.labels ?? []).map((l) => l.k),
          refs: b.galley?.refs ?? [],
          pages: blockPages.get(b.id) ?? [],
          // raw offsets into the main buffer for in-preview box editing;
          // blocks expanded from \input files are not editable in-place
          file: b.file ?? null,
          span: b.file ? null : { start: b.start, end: b.end },
        };
      }),
      // Environment child regions: independently editable views into an owner
      // block (paracol/multicols headings & paragraphs). Kept separate from
      // `blocks` so the outline/structure stay owner-grained, while the preview
      // can open a region and edit only its slice — the owner re-typesets whole,
      // so the resident daemon never receives partial TeX.
      regions: this.blocks.flatMap((b) =>
        b.file
          ? []
          : (b.children ?? []).map((child) => ({
              id: child.id,
              owner: child.ownerId,
              type: child.kind,
              column: child.column,
              layout: child.layout,
              source: {
                file: this.file,
                start: this.store.position(this.file, child.start),
                end: this.store.position(this.file, child.end),
              },
              span: { start: child.start, end: child.end },
              pages: blockPages.get(child.id) ?? [],
            }))
      ),
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

  async buildNativePageLayoutPoc({ text = this.getSource(), jobTag = 'sync' } = {}) {
    await this.#ensureShim();
    const safeTag = String(jobTag).replace(/[^0-9A-Za-z_-]+/g, '_');
    const jobdir = path.join(this.workDir, `page-layout-poc-${safeTag}`);
    rmSync(jobdir, { recursive: true, force: true });
    mkdirSync(jobdir, { recursive: true });

    const bounds = documentBounds(text);
    const segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
    const liveIds = new Map(
      this.blocks.map((b) => [`${b.start}:${b.end}:${b.hash}`, b.id])
    );
    const blocks = segs.map((s, i) => ({
      id: liveIds.get(`${s.start}:${s.end}:${s.hash}`) ?? `poc${i + 1}`,
      index: i,
      start: s.start,
      end: s.end,
      text: s.text,
      hash: s.hash,
    }));
    // Attach the same environment child regions the live engine exposes, so the
    // instrumentation can mark each region and glyphs come back region-tagged.
    for (const b of blocks) b.children = environmentChildren(b);

    const lua = path.join(jobdir, 'page-layout-poc.lua');
    const meta = path.join(jobdir, 'page-layout-poc.json');
    const tex = path.join(jobdir, 'page-layout-poc.tex');
    writeFileSync(lua, pageLayoutPocLuaSource(), 'utf8');
    writeFileSync(
      tex,
      instrumentPageLayoutPocSource(
        text,
        bounds,
        blocks,
        lua,
        meta,
        [
          ...BASE_COUNTERS,
          ...scanCounterDefs(text.slice(bounds.preamble.start, bounds.preamble.end)),
        ],
        path.join(this.workDir, 'tdomfork.so')
      ),
      'utf8'
    );

    const repoRoot = path.resolve(DIR, '..', '..');
    const env = {
      ...process.env,
      TEXINPUTS: `${this.docDir}//:${this.workDir}//:${jobdir}//:${repoRoot}//:${process.env.TEXINPUTS || ''}`,
      LUAINPUTS: `${this.docDir}//:${this.workDir}//:${jobdir}//:${repoRoot}//:${process.env.LUAINPUTS || ''}`,
    };
    const args = [
      '--shell-escape',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-synctex=1',
      '-output-directory',
      jobdir,
      tex,
    ];
    const run = () =>
      execFileP('lualatex', args, {
        cwd: this.docDir,
        timeout: 120_000,
        maxBuffer: 30 * 1024 * 1024,
        env,
      });
    try {
      await run();
      await run();
    } catch (err) {
      let log = '';
      try { log = readFileSync(path.join(jobdir, 'page-layout-poc.log'), 'utf8'); } catch { /* no log */ }
      throw new Error(`native page-layout PoC failed — ${texErrorFrom(log) || err.message}`);
    }
    if (!existsSync(meta)) throw new Error('native page-layout PoC produced no page metadata');

    const raw = JSON.parse(readFileSync(meta, 'utf8'));
    const pages = raw.pages ?? [];
    const pagesByBlock = new Map(blocks.map((b) => [b.id, []]));
    for (const page of pages) {
      for (const id of page.blockIds ?? []) {
        if (!pagesByBlock.has(id)) pagesByBlock.set(id, []);
        const arr = pagesByBlock.get(id);
        if (arr[arr.length - 1] !== page.number) arr.push(page.number);
      }
    }
    const pdf = path.join(jobdir, 'page-layout-poc.pdf');
    const synctex = path.join(jobdir, 'page-layout-poc.synctex.gz');
    return {
      engine: 'lualatex',
      mode: 'normal-tex-pre-shipout-callback',
      normalTex: true,
      texFile: tex,
      pdf: existsSync(pdf) ? pdf : null,
      synctex: existsSync(synctex) ? synctex : null,
      pageCount: pages.length,
      blocks: blocks.map((b) => ({
        id: b.id,
        index: b.index,
        start: b.start,
        end: b.end,
        pages: pagesByBlock.get(b.id) ?? [],
      })),
      pages,
      stats: {
        compilePasses: 2,
        blocks: blocks.length,
        pages: pages.length,
        blocksWithPages: [...pagesByBlock.values()].filter((v) => v.length > 0).length,
        glyphs: pages.reduce((n, p) => n + (p.glyphs?.length ?? 0), 0),
      },
    };
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
    // float capture: the environment body is typeset into a box with EXACTLY
    // the setup of LaTeX's \@xfloat (\hsize\columnwidth \@parboxrestore
    // \@floatboxreset — and no injected \centering), so the captured box is
    // byte-identical to what the real output routine would have placed. An
    // anchor \special marks the declaration point for the page builder.
    L.push('\\newbox\\TDOMfloatbox');
    L.push('\\directlua{TDOM_FLOATBOX=\\number\\TDOMfloatbox}');
    L.push('\\newcount\\TDOMfloatn');
    for (const env of ['figure', 'table']) {
      L.push(
        `\\renewenvironment{${env}}[1][\\csname fps@${env}\\endcsname]` +
          `{\\gdef\\TDOMfp{#1}\\def\\@captype{${env}}\\ifhmode\\@bsphack\\fi` +
          '\\global\\setbox\\TDOMfloatbox\\vbox\\bgroup\\hsize\\columnwidth\\@parboxrestore\\@floatboxreset}' +
          `{\\par\\vskip\\z@skip\\egroup\\global\\advance\\TDOMfloatn\\@ne` +
          `\\special{tdomfloat:\\number\\TDOMfloatn}` +
          `\\directlua{tdom_float(\\number\\TDOMfloatn,'\\TDOMfp','${env}')}` +
          `\\ifhmode\\@Esphack\\fi}`
      );
    }
    // \tableofcontents reads the toc the orchestrator maintains; never write
    L.push('\\renewcommand\\@starttoc[1]{{\\makeatletter\\@input{\\jobname.#1}}}');
    // live bibliography: define \b@<key> as \bibitem runs so \cite resolves
    L.push('\\ifdefined\\@bibitem\\let\\TDOMbibitem\\@bibitem');
    L.push("\\def\\@bibitem#1{\\TDOMbibitem{#1}\\directlua{tdom_bib('\\luaescapestring{#1}','\\luaescapestring{\\the\\value{enumiv}}')}}\\fi");
    L.push('\\ifdefined\\@lbibitem\\let\\TDOMlbibitem\\@lbibitem');
    L.push("\\def\\@lbibitem[#1]#2{\\TDOMlbibitem[#1]{#2}\\directlua{tdom_bib('\\luaescapestring{#2}','\\luaescapestring{#1}')}}\\fi");
    // Packages such as multicol can bypass our dormant \output handler by
    // calling LaTeX's \@outputpage from their own output routine. Capture
    // the assembled page box back into the resident galley instead of
    // shipping it to the driver's PDF.
    L.push('\\newbox\\TDOMoutputpagebox');
    L.push('\\let\\TDOMorigoutputpage\\@outputpage');
    L.push(
      '\\def\\@outputpage{\\global\\setbox\\TDOMoutputpagebox\\box\\@outputbox' +
        '\\directlua{tdom_capture_outputpage(\\number\\TDOMoutputpagebox,\\number\\@colroom)}' +
        '\\global\\advance\\c@page\\@ne}'
    );
    // page-builder geometry: every parameter the output routine uses is read
    // from the live TeX run — glue parameters travel with their full
    // stretch/shrink specification (\gluestretch etc. are LuaTeX primitives)
    const glueParam = (name, expr) =>
      `\\directlua{tdom_glue('${name}',\\number\\dimexpr${expr}\\relax,` +
      `\\number\\gluestretch${expr},\\number\\glueshrink${expr},` +
      `\\number\\gluestretchorder${expr},\\number\\glueshrinkorder${expr})}`;
    L.push(glueParam('footinsskip', '\\skip\\footins'));
    L.push(glueParam('topskip', '\\topskip'));
    L.push(glueParam('floatsep', '\\floatsep'));
    L.push(glueParam('textfloatsep', '\\textfloatsep'));
    L.push(glueParam('intextsep', '\\intextsep'));
    L.push(glueParam('fptop', '\\@fptop'));
    L.push(glueParam('fpsep', '\\@fpsep'));
    L.push(glueParam('fpbot', '\\@fpbot'));
    L.push('\\directlua{tdom_num(\'topfraction\',\\topfraction)}');
    L.push('\\directlua{tdom_num(\'bottomfraction\',\\bottomfraction)}');
    L.push('\\directlua{tdom_num(\'textfraction\',\\textfraction)}');
    L.push('\\directlua{tdom_num(\'floatpagefraction\',\\floatpagefraction)}');
    L.push('\\directlua{tdom_num(\'topnumber\',\\value{topnumber})}');
    L.push('\\directlua{tdom_num(\'bottomnumber\',\\value{bottomnumber})}');
    L.push('\\directlua{tdom_num(\'totalnumber\',\\value{totalnumber})}');
    L.push('\\directlua{tdom_num(\'interlinepenalty\',\\interlinepenalty)}');
    L.push('\\directlua{tdom_num(\'footinsfactor\',\\count\\footins)}');
    L.push('\\directlua{tdom_dim(\'atmaxdepth\',\\number\\dimexpr\\@maxdepth\\relax)}');
    // \raggedbottom leaves \@textbottom = \vskip\z@\@plus.0001fil; flushbottom
    // keeps it \relax — the page builder needs to know which world it's in
    L.push('\\ifx\\@textbottom\\relax\\directlua{tdom_num(\'raggedbottom\',0)}' +
      '\\else\\directlua{tdom_num(\'raggedbottom\',1)}\\fi');
    // the class's real \footnoterule, measured (kerns+rule items, verbatim)
    L.push('\\setbox0=\\vbox{\\hsize=\\textwidth\\footnoterule}');
    L.push('\\directlua{tdom_footrule(0)}');
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
    // Dormant page builder: blocks are typeset on the REAL main vertical
    // list (full state continuity — \prevdepth, \everypar, penalties), the
    // page never fills (\vsize=\maxdimen), inserts stay in the stream
    // (\holdinginserts), and a dummy box keeps the page "started" so TeX
    // never discards inter-block glue. tdom_report() harvests the nodes.
    // The output routine only ever fires on force-ejects (\newpage & co);
    // tdom_absorb_output puts the material back and plants a break marker.
    L.push('\\vsize=\\maxdimen');
    L.push('\\holdinginserts=1');
    L.push('\\maxdeadcycles=200');
    L.push('\\output={\\directlua{tdom_absorb_output()}}');
    // a real box first: flips the page builder's internal page_contents
    // flag to box_there (unreachable from Lua); tdom_seed then swaps the
    // list for the marker dummy
    L.push('\\hbox to0pt{}');
    L.push('\\prevdepth=-1000pt');
    L.push('\\directlua{tdom_seed()}');
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
    const multicolRoom = multicolBlockInfo(block.text) ? this.#remainingTextHeightBefore(idx) : null;
    const layoutPrelude = multicolRoom != null
      ? `\\makeatletter\\global\\@colroom=${dimBp(multicolRoom)}\\relax\\makeatother\n`
      : '';
    // Mid-typing safety: an unclosed brace makes a \long macro argument
    // scan past the injected \par/report tokens to EOF and kills the child
    // (the old \vbox wrapper stopped it structurally). Auto-close the
    // imbalance — the source is transiently invalid anyway, and the exact
    // path resumes on the next balanced keystroke.
    const guard = '}'.repeat(Math.max(0, braceImbalance(block.text)));
    const body = Buffer.from(prelude + layoutPrelude + block.text + guard, 'utf8');
    const galleyKey = 'galley:' + block.id;
    const ckptKey = 'ckpt:' + (idx + 1);
    const galleyP = this.#await(galleyKey);
    const ckptP = this.#await(ckptKey);
    this.currentJob = { galleyKey, ckptKey, parent: ck, ckptIdx: idx + 1 };
    try {
      ck.send(`JOB ${block.id} ${idx + 1} ${body.length}\n`);
      ck.sendRaw(body);
      const [galley] = await Promise.all([galleyP, ckptP]);
      this.#retireOffGrid(idx);
      return galley;
    } finally {
      this.currentJob = null;
    }
  }

  #remainingTextHeightBefore(idx) {
    if (!this.geometry?.textheight || idx <= 0) return null;
    const stream = [];
    for (let j = 0; j < idx; j++) {
      const block = this.blocks[j];
      if (!block?.galley) continue;
      const bc = this.chunks.get(block.id);
      const hasChunk = !!bc && bc.forGalley === block.galleyHash;
      stream.push(...buildStream(block, hasChunk, this.chunks));
    }
    const probe = {
      blockId: '_tdom_probe',
      li: -1,
      h: 0.01,
      d: 0,
      ln: { descent: 0, boxH: 0.01, runs: [], gfxChunk: null },
    };
    stream.push({ t: 'box', u: probe });
    const pages = buildPages(stream, this.geometry);
    const page = pages.find((p) => (p.draw ?? []).some((d) => d.u === probe));
    const entry = page?.draw?.find((d) => d.u === probe);
    if (!page || !entry) return null;
    const priorDraw = (page.draw ?? []).some((d) => d.u !== probe);
    const priorFloats = (page.topFloats?.length ?? 0) + (page.botFloats?.length ?? 0);
    if (!priorDraw && !priorFloats) return this.geometry.textheight;
    const top = Math.max(0, entry.y - probe.h);
    const remaining = this.geometry.textheight - top;
    if (!Number.isFinite(remaining)) return null;
    return Math.max(0, Math.min(this.geometry.textheight, remaining));
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

  /**
   * Retypeset blocks from `from` at least through `target`, then keep going
   * until a re-typeset block reproduces its previous galley AND exit state
   * (counters + prevdepth + \if@nobreak) exactly. Cross-block layout state
   * makes downstream galleys stale after ANY upstream re-typeset — the same
   * self-verifying convergence as the main edit path, factored out so the
   * toc and backward-reference passes cannot cut the chain short.
   * Returns the number of blocks typeset; reports (idx, changed) per block.
   */
  async #retypesetChain(from, target, onBlock) {
    let n = 0;
    for (let j = from; j < this.blocks.length; j++) {
      const block = this.blocks[j];
      const before = { hash: block.galleyHash, state: block.stateVec };
      const g = await this.#jobBlock(j).catch(() => null);
      if (!g) break;
      this.#adoptGalley(block, g);
      n++;
      const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
      onBlock?.(j, changed);
      if (j >= target && !changed) break;
    }
    return n;
  }

  #adoptGalley(block, galley) {
    block.galley = galley;
    block.galleyHash = fnv1a(
      JSON.stringify([galley.items, galley.floats, galley.w, galley.h, galley.d])
    );
    // exit state = tracked counters + cross-block layout state (prevdepth,
    // \if@nobreak) — any change forces the convergence chain onward
    block.stateVec = JSON.stringify([
      ...this.counters.map((c) => galley.state?.[c] ?? 0),
      galley.state?.['tdom@pd'] ?? 0,
      galley.state?.['tdom@nobreak'] ?? 0,
    ]);
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
    // Recompute environment child regions (cheap; non-empty only for column
    // environments) so getDOM and native hitboxes see fresh, editable children.
    for (const b of this.blocks) b.children = environmentChildren(b);
    const dirtySource = new Set(diff.dirty);
    t.lap('segment');

    const earlyFullPagePreview = editLabel === 'open' ? fullPagePreviewReason(text) : '';
    if (earlyFullPagePreview) {
      let pages;
      let reused = 0;
      let rebuilt = 0;
      let fullPagePreviewPending = false;
      if (editLabel !== 'open' && this.pages.length > 0) {
        pages = this.pages;
        reused = pages.length;
        fullPagePreviewPending = true;
      } else {
        pages = await this.#fullPagePreview(text);
        const prevByHash = new Set(this.pages.map((p) => p.dl?.hash).filter(Boolean));
        reused = pages.filter((p) => prevByHash.has(p.dl?.hash)).length;
        rebuilt = pages.length - reused;
      }
      t.lap('typeset');
      t.lap('toc');
      const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
      const prevCount = this.pages.length;
      const patches = [];
      for (const p of pages) {
        if (prevHashes.get(p.number) !== p.dl.hash) {
          patches.push({ type: 'replace-page', page: p.number, displayList: p.dl });
        }
      }
      if (pages.length < prevCount) patches.push({ type: 'remove-pages', from: pages.length + 1 });
      this.pages = pages;
      this.fullPagePreviewActive = true;
      t.lap('paginate');
      if (fullPagePreviewPending) this.#scheduleFullPagePreview(text, earlyFullPagePreview);
      t.lap('schedule');
      this.rev++;
      return {
        rev: this.rev,
        edit: editLabel,
        backend: this.backendName,
        dirtySourceNodes: [...dirtySource].map((id) => 'src-' + id),
        dirtySemanticNodes: [...dirtySource].map((id) => 'blk-' + id),
        dirtyDependencies: [],
        dirtyLayoutNodes: [...dirtySource].map((id) => 'galley-' + id),
        dirtyPages: patches.filter((p) => p.type === 'replace-page').map((p) => p.page),
        patches,
        stats: {
          ...t.done(),
          blocksTotal: this.blocks.length,
          blocksTypeset: 0,
          blocksReparsed: dirtySource.size,
          semanticCacheHits: this.blocks.length - dirtySource.size,
          layoutCacheHits: this.blocks.length,
          layoutCacheMisses: 0,
          typesetMs: 0,
          rebooted,
          checkpoints: this.checkpoints.size,
          pagesReused: reused,
          pagesRebuilt: rebuilt,
          pageCount: pages.length,
          fullPagePreview: true,
          fullPagePreviewReason: earlyFullPagePreview,
          fullPagePreviewPending,
          macrosChanged: [],
          labelsChanged: [],
          diagnostics: [`full-page exact preview path: ${earlyFullPagePreview}`],
        },
      };
    }

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
        await this.#retypesetChain(from, c, (j, changed) => {
          typesetCount++;
          if (j === c && changed) {
            dirtyBlocks.push(block.id);
            for (const k of block.galley.refs ?? []) {
              if (changedLabels.has(k)) push2(depDirty, 'label', k, block.id);
            }
          } else if (j > c && changed) {
            dirtyBlocks.push(this.blocks[j].id);
          }
        });
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
        await this.#retypesetChain(from, c, (j, changed) => {
          typesetCount++;
          if (changed && j >= c) {
            dirtyBlocks.push(this.blocks[j].id);
            if (j === c) push2(depDirty, 'toc', 'contents', block.id);
          }
        });
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
    const fullPagePreview = fullPagePreviewReason(text);
    const deferFullPagePreview = !!fullPagePreview && editLabel !== 'open' && this.pages.length > 0;
    let fullPagePreviewPending = false;
    let pagesRaw;
    let pages;
    let reused;
    let rebuilt;
    if (!fullPagePreview) this.fullPagePreviewSeq++;
    if (fullPagePreview && !deferFullPagePreview) {
      try {
        pages = await this.#fullPagePreview(text);
        const prevByHash = new Set(this.pages.map((p) => p.dl?.hash).filter(Boolean));
        reused = pages.filter((p) => prevByHash.has(p.dl?.hash)).length;
        rebuilt = pages.length - reused;
        diagnostics.push(`full-page exact preview path: ${fullPagePreview}`);
      } catch (err) {
        diagnostics.push(`full-page exact preview failed (${err.message}); using live page builder`);
      }
    }
    if (!pages) {
      pagesRaw = this.#paginateNow();
      ({ pages, reused, rebuilt } = reconcile(pagesRaw, this.pages));
      if (fullPagePreview && deferFullPagePreview) {
        fullPagePreviewPending = true;
        diagnostics.push(`full-page live preview patched; exact preview queued: ${fullPagePreview}`);
      }
    }
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
    this.fullPagePreviewActive = !!fullPagePreview && !pagesRaw;
    t.lap('paginate');

    // ---- async work: rebuild remaining checkpoint chain + gfx renders --
    this.#scheduleBackground(fgStop, dirtyBlocks);
    if (fullPagePreviewPending) this.#scheduleFullPagePreview(text, fullPagePreview);
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
        fullPagePreview: !!fullPagePreview && !pagesRaw,
        fullPagePreviewReason: fullPagePreview,
        fullPagePreviewPending,
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
          if (block.needsRender) {
            this.renderTask = (this.renderTask ?? Promise.resolve()).then(() =>
              this.#renderBlock(block).catch((err) => {
                this.diagnostics.push(`render ${block.id}: ${err.message}`);
              })
            );
          }
        }
      }
    })();
    const renders = [];
    const fresh = (key, block) => {
      const c = this.chunks.get(key);
      return !!c && c.forGalley === block.galleyHash;
    };
    for (const block of this.blocks) {
      const missingChunk =
        (block.gfx && !fresh(block.id, block)) ||
        (block.galley?.floats ?? []).some((f) => f.gfx && !fresh(block.id + '#' + f.n, block));
      if (block.needsRender && (dirtyBlocks.includes(block.id) || missingChunk)) {
        renders.push(
          this.bgTask
            .then(() => this.#renderBlock(block))
            .catch((err) => {
              this.diagnostics.push(`render ${block.id}: ${err.message}`);
            })
        );
      }
    }
    // exposed so tools/tests can wait for the exact-render tier to settle
    this.renderTask = Promise.all(renders).then(() => {});
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
    const guard = '}'.repeat(Math.max(0, braceImbalance(block.text)));
    const body = Buffer.from(block.text + guard, 'utf8');
    const done = this.#await('render:' + block.id, 60_000);
    ck.send(`RENDER ${block.id} ${jobdir} ${body.length}\n`);
    ck.sendRaw(body);
    await done;
    const pdf = path.join(jobdir, 'driver.pdf');
    // DONE fires from finish_pdffile, but the child's stdio buffers reach
    // the disk only on _exit — wait until the file is complete (%%EOF)
    await waitForPdf(pdf);
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
      const svg = cropSvg(readFileSync(svgPath, 'utf8'), tgt.w, tgt.h);
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
      // entry counters = the previous block's REAL exit vector (captured
      // from TeX by the galley report); zeros at the document start
      const entry = {};
      const prevVec = idx > 0 ? JSON.parse(this.blocks[idx - 1].stateVec ?? '[]') : [];
      this.counters.forEach((c, i) => {
        entry[c] = prevVec[i] ?? 0;
      });
      // cross-block layout state from the previous block's REAL exit vector:
      // [..counters.., tdom@pd, tdom@nobreak] — prevdepth reproduces the
      // exact leading interline glue, @nobreak the post-heading \everypar
      const prevPd = idx > 0 && prevVec.length >= 2 ? prevVec[prevVec.length - 2] : -65536000;
      const prevNobreak = idx > 0 && prevVec.length >= 1 ? prevVec[prevVec.length - 1] === 1 : false;
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
      // same dormant-page technique as the resident daemon: typeset on the
      // real MVL (state-faithful spacing), then harvest, vpack and ship
      L.push('\\vsize=\\maxdimen');
      L.push('\\holdinginserts=1');
      L.push('\\maxdeadcycles=200');
      L.push('\\hbox to0pt{}');
      L.push('\\special{tdom:isostart}');
      L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(prevPd)}}`);
      if (prevNobreak) L.push('\\noindent');
      L.push(block.text.trimEnd() + '}'.repeat(Math.max(0, braceImbalance(block.text))));
      L.push('\\par');
      L.push(
        '\\directlua{' +
          'tex.triggerbuildpage() ' +
          'local head = tex.lists.page_head ' +
          'tex.lists.page_head = nil tex.lists.contrib_head = nil ' +
          'local INS = node.id("ins") local WH = node.id("whatsit") ' +
          'local SP = node.subtype("special") ' +
          // everything up to and including the isostart marker is pre-body
          // machinery (begin-document whatsits, \topskip glue, the seed box)
          'while head do ' +
          'local ismark = head.id == WH and head.subtype == SP and head.data == "tdom:isostart" ' +
          'local nxt = head.next head.next = nil if nxt then nxt.prev = nil end node.free(head) head = nxt ' +
          'if ismark then break end end ' +
          'local out, tail = nil, nil local n = head ' +
          'while n do local nxt = n.next n.next = nil n.prev = nil ' +
          'if n.id == INS then node.free(n) else if tail then tail.next = n n.prev = tail else out = n end tail = n end n = nxt end ' +
          'if out then local b = node.vpack(out) ' +
          'tex.box[255] = b tex.pagewidth = math.max(b.width or 0, 65536) ' +
          'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536) end}'
      );
      L.push('\\shipout\\box255');
      L.push('\\csname @@end\\endcsname');
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
      // the shipped page can come out paper-sized when a class hooks the
      // shipout (luatexja); the box sits at the origin (\hoffset=-1in), so
      // cropping the viewBox to the known galley extent is always exact
      const svg = cropSvg(
        readFileSync(svgPath, 'utf8'),
        block.galley.w,
        block.galley.h + block.galley.d
      );
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
    if (this.fullPagePreviewActive) return;
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

  #scheduleFullPagePreview(text, reason) {
    const token = ++this.fullPagePreviewSeq;
    const sourceHash = fnv1a(text);
    const stillCurrent = () =>
      token === this.fullPagePreviewSeq &&
      fnv1a(this.store.get(this.file)) === sourceHash &&
      fullPagePreviewReason(this.store.get(this.file)) === reason;

    (async () => {
      await sleep(250);
      if (!stillCurrent()) return;
      const pages = await this.#fullPagePreview(text, `async-${token}`, stillCurrent);
      if (!pages || !stillCurrent()) return;

      const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
      const prevCount = this.pages.length;
      const patches = [];
      for (const page of pages) {
        if (page.dl?.hash !== prevHashes.get(page.number)) {
          patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
        }
      }
      if (pages.length < prevCount) patches.push({ type: 'remove-pages', from: pages.length + 1 });
      this.pages = pages;
      this.fullPagePreviewActive = true;
      if (this.onAsyncPatches) {
        this.rev++;
        const dirtyPages = patches.filter((p) => p.type === 'replace-page').map((p) => p.page);
        this.onAsyncPatches({
          rev: this.rev,
          patches,
          report: {
            rev: this.rev,
            edit: `async full-page preview: ${reason}`,
            backend: this.backendName,
            dirtySourceNodes: [],
            dirtySemanticNodes: [],
            dirtyDependencies: [],
            dirtyLayoutNodes: [],
            dirtyPages,
            patches,
            stats: {
              bootUs: 0,
              segmentUs: 0,
              typesetUs: 0,
              tocUs: 0,
              paginateUs: 0,
              scheduleUs: 0,
              totalUs: 0,
              blocksTotal: this.blocks.length,
              blocksTypeset: 0,
              blocksReparsed: 0,
              semanticCacheHits: this.blocks.length,
              layoutCacheHits: this.blocks.length,
              layoutCacheMisses: 0,
              typesetMs: 0,
              rebooted: false,
              checkpoints: this.checkpoints.size,
              pagesReused: Math.max(0, pages.length - dirtyPages.length),
              pagesRebuilt: dirtyPages.length,
              pageCount: pages.length,
              fullPagePreview: true,
              fullPagePreviewReason: reason,
              fullPagePreviewPending: false,
              macrosChanged: [],
              labelsChanged: [],
              diagnostics: [`full-page exact preview completed async: ${reason}`],
            },
          },
        });
      }
    })().catch((err) => {
      if (stillCurrent()) this.diagnostics.push(`full-page exact preview failed async (${err.message})`);
    });
  }

  async #fullPagePreview(text, jobTag = 'sync', shouldApply = () => true) {
    const geo = this.geometry ?? {};
    const w = geo.paperwidth ?? 612;
    const h = geo.paperheight ?? 792;

    // Preferred path: native shipout instrumentation. The pre_shipout_filter
    // callback attributes every glyph to the block that produced it, so edit
    // hitboxes are recovered from real per-block glyph boxes instead of from
    // fuzzy pdftotext word matching. That removes both failure modes of the
    // heuristic: short/common-word blocks that got no box, and boxes landing
    // on the wrong page. Fall back to the pdftotext path if the native
    // capture is unavailable (no fork shim, instrumentation compile error…).
    let native = null;
    try {
      native = await this.buildNativePageLayoutPoc({ text, jobTag: `fp-${jobTag}` });
      if (!native.pdf || !native.pageCount) native = null;
    } catch (err) {
      this.diagnostics.push(`native page-layout capture unavailable (${err.message}); using pdftotext hitboxes`);
      native = null;
    }

    if (native) {
      const hitboxes = this.#nativeFullPageHitboxes(native, w, h);
      const nativeDir = path.dirname(native.pdf);
      return this.#assembleFullPagePages(native.pdf, native.pageCount, hitboxes, w, h, nativeDir, shouldApply);
    }

    const safeTag = String(jobTag).replace(/[^0-9A-Za-z_-]+/g, '_');
    const jobdir = path.join(this.workDir, `full-page-preview-${safeTag}`);
    rmSync(jobdir, { recursive: true, force: true });
    mkdirSync(jobdir, { recursive: true });
    const tex = path.join(jobdir, 'preview.tex');
    writeFileSync(tex, text.replace(/\r\n?/g, '\n'), 'utf8');
    const repoRoot = path.resolve(DIR, '..', '..');
    const env = {
      ...process.env,
      TEXINPUTS: `${this.docDir}//:${this.workDir}//:${jobdir}//:${repoRoot}//:${process.env.TEXINPUTS || ''}`,
      LUAINPUTS: `${this.docDir}//:${this.workDir}//:${jobdir}//:${repoRoot}//:${process.env.LUAINPUTS || ''}`,
    };
    const run = () =>
      execFileP(
        'lualatex',
        ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', jobdir, tex],
        { cwd: this.docDir, timeout: 120_000, env }
      );
    await run();
    await run();
    const pdf = path.join(jobdir, 'preview.pdf');
    if (!existsSync(pdf)) throw new Error('full-page compile produced no PDF');
    const info = await execFileP('pdfinfo', [pdf], { timeout: 30_000 });
    const pageCount = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pageCount) throw new Error('could not read full-page PDF page count');
    const hitboxes = await this.#fullPageHitboxes(pdf, w, h).catch((err) => {
      this.diagnostics.push(`full-page hitboxes unavailable: ${err.message}`);
      return new Map();
    });
    return this.#assembleFullPagePages(pdf, pageCount, hitboxes, w, h, jobdir, shouldApply);
  }

  // Render each page of a full-page PDF to SVG and pack it with its edit
  // hitboxes into a display list. Shared by the native and pdftotext paths.
  async #assembleFullPagePages(pdf, pageCount, hitboxes, w, h, jobdir, shouldApply) {
    const pageSvgs = [];
    for (let n = 1; n <= pageCount; n++) {
      const key = `_fullpage-${n}`;
      const svgPath = path.join(jobdir, `page-${n}.svg`);
      await execFileP('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), pdf, svgPath], {
        timeout: 30_000,
      });
      const svg = cropSvg(readFileSync(svgPath, 'utf8'), w, h);
      pageSvgs.push({ n, key, svg });
    }
    if (!shouldApply()) return null;

    const pages = [];
    for (const { n, key, svg } of pageSvgs) {
      const prev = this.chunks.get(key);
      const v = prev?.svg === svg ? prev.v : (prev?.v ?? 0) + 1;
      this.chunks.set(key, { svg, wBp: w, hBp: h, v, forGalley: 'full-page' });
      const commands = [
        {
          op: 'chunk',
          chunk: key,
          x: 0,
          y: 0,
          w: r2(w),
          h: r2(h),
          sy: 0,
          ch: r2(h),
          cv: v,
          src: key,
        },
      ];
      for (const hb of hitboxes.get(n) ?? []) {
        commands.push({ op: 'hitbox', ...hb });
      }
      const dl = { page: n, commands };
      dl.hash = fnv1a(JSON.stringify(dl.commands));
      pages.push({
        number: n,
        draw: [],
        feet: [],
        topFloats: [],
        botFloats: [],
        dl,
      });
    }
    return pages;
  }

  // Build edit hitboxes from native per-glyph block attribution. Each glyph the
  // shipout callback captured carries the id of the block it came from plus its
  // exact ink metrics, so a block's hitbox is just the union of its glyph boxes
  // — no term matching, no page guessing. Column environments still emit one
  // box per column (and per source child region, when the segmenter split the
  // environment) so the preview stays column-editable.
  #nativeFullPageHitboxes(native, pageW, pageH) {
    const ORIGIN = 72; // pdf horigin/vorigin default = 1in = 72bp (see probe)
    const blockById = new Map(this.blocks.map((b) => [b.id, b]));
    const childById = this.#childRegions();
    const toBoxes = (glyphs) =>
      glyphs.map((g) => ({
        x0: g.x + ORIGIN,
        y0: g.y - (g.h ?? 0) + ORIGIN,
        x1: g.x + (g.w ?? 0) + ORIGIN,
        y1: g.y + (g.d ?? 0) + ORIGIN,
      }));
    const out = new Map();
    for (const page of native.pages ?? []) {
      const byKey = new Map();
      for (const g of page.glyphs ?? []) {
        if (!g.block) continue;
        // Glyphs tagged with a child region report under the region id so the
        // region gets its own box; the region still names its owning block.
        const key = g.region || g.block;
        if (!byKey.has(key)) byKey.set(key, { block: g.block, region: g.region || null, glyphs: [] });
        byKey.get(key).glyphs.push(g);
      }
      const rects = [];
      for (const { block: bid, region, glyphs } of byKey.values()) {
        const block = blockById.get(bid);
        if (!block) continue;
        const boxes = toBoxes(glyphs);

        // --- child region of a column environment (independently editable) ---
        if (region) {
          const child = childById.get(region);
          if (!child) continue;
          if (Number.isFinite(child.column)) {
            // paracol: the column is known statically — one tight box.
            for (const rect of rectsForWords(boxes, { pageW, pageH })) {
              rects.push({ src: region, region, owner: bid, layout: child.layout, column: child.column, x: r2(rect.x), y: r2(rect.y), w: r2(rect.w), h: r2(rect.h) });
            }
          } else {
            // multicols: content flows across columns; recover them from x.
            for (const box of columnRectsForWords(boxes, child.cols ?? 2, pageW, pageH)) {
              rects.push({ src: region, region, owner: bid, layout: child.layout, column: box.col, x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h) });
            }
          }
          continue;
        }

        // --- whole-block hitbox (no child regions covered these glyphs) ---
        // A page-break-only block (\clearpage, \newpage, \onecolumn…) ships no
        // ink of its own. Any glyph tagged to it is the page footer/header the
        // output routine emitted while its start marker was the active block —
        // dropping it avoids a stray hitbox over the page number.
        if (!blockHasVisibleText(block.text)) continue;
        const columnInfo = columnLayoutBlockInfo(block.text);
        if (columnInfo) {
          for (const box of columnRectsForWords(boxes, columnInfo.cols, pageW, pageH)) {
            rects.push({ src: bid, layout: columnInfo.layout, column: box.col, x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h) });
          }
          continue;
        }
        for (const rect of rectsForWords(boxes, { pageW, pageH })) {
          rects.push({ src: bid, x: r2(rect.x), y: r2(rect.y), w: r2(rect.w), h: r2(rect.h) });
        }
      }
      if (rects.length) out.set(page.number, rects);
    }
    return out;
  }

  // Map child-region id -> child descriptor, across all environment blocks.
  #childRegions() {
    const map = new Map();
    for (const block of this.blocks) {
      for (const child of block.children ?? []) map.set(child.id, child);
    }
    return map;
  }

  async #fullPageHitboxes(pdf, pageW, pageH) {
    const { stdout } = await execFileP('pdftotext', ['-bbox', pdf, '-'], {
      timeout: 30_000,
      maxBuffer: 30 * 1024 * 1024,
    });
    const pageWords = parsePdfBboxWords(stdout);
    const out = new Map();
    const termsByBlock = new Map();
    const termBlocks = new Map();
    for (const block of this.blocks) {
      const terms = significantTerms(block.text);
      termsByBlock.set(block, terms);
      for (const term of terms) {
        if (!termBlocks.has(term)) termBlocks.set(term, new Set());
        termBlocks.get(term).add(block.id);
      }
    }
    const lastPageNo = Math.max(1, ...pageWords.map((p) => p.n));
    let minCandidatePage = 1;
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      const nextBlockForcesPageBreak = forcesFullPageBreak(this.blocks[i + 1]?.text ?? '');
      const maxCandidatePage = nextBlockForcesPageBreak ? minCandidatePage : lastPageNo;
      const allTerms = termsByBlock.get(block) ?? new Set();
      const uniqueTerms = new Set([...allTerms].filter((term) => (termBlocks.get(term)?.size ?? 0) === 1));
      const columnInfo = columnLayoutBlockInfo(block.text);
      const terms = uniqueTerms.size ? uniqueTerms : (columnInfo ? allTerms : new Set());
      if (!terms.size) {
        if (forcesFullPageBreak(block.text)) minCandidatePage = Math.min(lastPageNo, minCandidatePage + 1);
        continue;
      }
      const isWideBlock = columnInfo != null || /\\begin\s*\{paracol\*?\}/.test(block.text);
      for (const page of pageWords) {
        if (page.n < minCandidatePage) continue;
        if (page.n > maxCandidatePage) continue;
        if (uniqueTerms.size) {
          const uniqueMatches = page.words.filter((w) => uniqueTerms.has(w.n));
          if (!uniqueMatches.length) continue;
        }
        const matches = page.words.filter((w) => terms.has(w.n));
        const minMatches = isWideBlock
          ? Math.min(8, Math.max(2, terms.size))
          : uniqueTerms.size >= 1
            ? 1
            : Math.min(4, Math.max(2, terms.size));
        if (matches.length < minMatches) continue;
        if (!out.has(page.n)) out.set(page.n, []);
        // Full-page exact previews are images, so editable regions must be
        // reconstructed from PDF word boxes. Multi-column blocks need several
        // tight column/paragraph boxes; a single union rectangle becomes a
        // page-sized blue outline around unrelated columns and gaps.
        if (columnInfo && matches.length >= columnInfo.cols * 2) {
          for (const box of columnRectsForWords(matches, columnInfo.cols, pageW, pageH)) {
            out.get(page.n).push({
              src: block.id,
              layout: columnInfo.layout,
              column: box.col,
              x: r2(box.x),
              y: r2(box.y),
              w: r2(box.w),
              h: r2(box.h),
            });
          }
          continue;
        }
        const rects = rectsForWords(matches, {
          trimOutliers: isWideBlock && matches.length > 20,
          pageW,
          pageH,
        });
        for (const rect of rects) {
          out.get(page.n).push({
            src: block.id,
            x: r2(rect.x),
            y: r2(rect.y),
            w: r2(rect.w),
            h: r2(rect.h),
          });
        }
      }
      if (forcesFullPageBreak(block.text)) minCandidatePage = Math.min(lastPageNo, minCandidatePage + 1);
    }
    return out;
  }

  // --------------------------------------------------------------- units

  #paginateNow() {
    this.#rebuildUnits();
    const stream = [];
    for (const block of this.blocks) stream.push(...(block.units ?? []));
    return buildPages(stream, this.geometry);
  }

  #rebuildUnits() {
    for (const block of this.blocks) {
      const bc = this.chunks.get(block.id);
      const hasChunk = !!bc && bc.forGalley === block.galleyHash;
      const floatVs = (block.galley?.floats ?? [])
        .map((f) => {
          const fc = this.chunks.get(block.id + '#' + f.n);
          return fc && fc.forGalley === block.galleyHash ? fc.v : 0;
        })
        .join(',');
      const sig = `${block.galleyHash}|${hasChunk ? bc.v : 0}|${floatVs}`;
      if (!block.units || block.unitsSig !== sig) {
        block.units = buildStream(block, hasChunk, this.chunks);
        block.unitsSig = sig;
      }
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
      if (process.env.TDOM_DEBUG_TOC && /\\section/.test(block.text)) {
        console.error(`toc? ${block.id} m=${!!m} star=${m?.[2]} sv=${!!block.stateVec} text=${JSON.stringify(block.text.slice(0, 40))}`);
      }
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
    const multicolBlocks = new Map(
      this.blocks
        .map((b) => [b.id, multicolBlockInfo(b.text)])
        .filter(([, info]) => info)
    );
    const layoutFor = (blockId) => (multicolBlocks.has(blockId) ? 'multicol' : undefined);
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
      const u = entry.u;
      const baseline = T + entry.y;
      if (u.ln.gfxChunk) {
        const c = u.ln.gfxChunk;
        const unitTop = baseline - u.ln.boxH;
        const chunkTop = unitTop - c.yOff;
        const clip0 = c.yOff;
        const clip1 = c.yOff + u.h + (u.d ?? 0);
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
            layout: layoutFor(u.blockId),
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
            layout: layoutFor(u.blockId),
          });
        }
      }
    }
    flushGfx();
    addMulticolHitboxes(commands, multicolBlocks, geo, L);
    // page style plain: \@thefoot = \hfil\thepage\hfil in an \hbox appended
    // with \baselineskip=\footskip — the folio baseline lands exactly
    // \footskip below the text area (see \@outputpage)
    commands.push({
      op: 'folio',
      x: r2(L + geo.textwidth / 2),
      y: r2(T + geo.textheight + (geo.footskip ?? 30)),
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
 * galley items -> the page builder's input stream. The items ARE the real
 * main vertical list (boxes, glue with full specs, penalties, inserts,
 * float anchors, eject markers) — this function only reshapes them into
 * stream entries and attaches drawing/chunk metadata. Entry objects are
 * cached per block (unitsSig), so page identity survives unrelated edits.
 */
function buildStream(block, hasChunk, chunks) {
  const items = block.galley?.items ?? [];
  const floats = block.galley?.floats ?? [];
  const stream = [];
  let li = 0;
  let yOff = 0;

  const makeFloat = (n) => {
    const f = floats.find((x) => x.n === n);
    if (!f) return null;
    const chunkKey = block.id + '#' + f.n;
    const fc = chunks.get(chunkKey);
    const chunkRef =
      f.gfx && fc && fc.forGalley === block.galleyHash ? { key: chunkKey, w: f.w } : null;
    return {
      id: chunkKey,
      n: f.n,
      place: parsePlacement(f.placement),
      type: f.type,
      w: f.w,
      h: f.h ?? 0,
      d: f.d ?? 0,
      gfx: f.gfx,
      blockId: block.id,
      units: miniUnits(f.items, block.id, chunkRef),
    };
  };

  for (const it of items) {
    if (it.k === 'glue') {
      stream.push({ t: 'glue', a: it.a ?? 0, st: it.st ?? 0, sto: it.sto ?? 0, sh: it.sh ?? 0, sho: it.sho ?? 0, sub: it.sub ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'kern') {
      stream.push({ t: 'kern', a: it.a ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'pen') {
      stream.push({ t: 'pen', v: it.v ?? 0 });
    } else if (it.k === 'ins') {
      stream.push({
        t: 'ins',
        h: it.h ?? it.hc ?? 0,
        d: it.d ?? 0,
        hc: it.hc ?? it.h ?? 0,
        units: miniUnits(it.items, block.id, null),
      });
    } else if (it.k === 'fm') {
      const f = makeFloat(it.n);
      if (f) stream.push({ t: 'fm', f, vmode: true });
    } else if (it.k === 'eject') {
      stream.push({ t: 'eject', v: it.v ?? -10000 });
    } else if (it.k === 'box') {
      const unit = {
        blockId: block.id,
        li: li++,
        h: it.h ?? 0,
        d: it.d ?? 0,
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
      stream.push({ t: 'box', u: unit });
      yOff += (it.h ?? 0) + (it.d ?? 0);
      if (it.fm) {
        for (const n of it.fm) {
          const f = makeFloat(n);
          if (f) stream.push({ t: 'fm', f, vmode: false });
        }
      }
    }
  }
  return stream;
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
      h: it.h ?? 0,
      d: it.d ?? 0,
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

function fullPagePreviewReason(text) {
  // Balancing multicols (non-starred) with 4+ columns deterministically crashes
  // the resident TeX daemon for some column/body-length combinations, so route
  // it to the exact full-page image. multicols* (no balancing) is stable on the
  // resident path and keeps its editable glyph layout. The full-page path still
  // synthesizes per-column edit hitboxes (see #fullPageHitboxes), so the exact
  // fallback is not read-only.
  for (const multicol of text.matchAll(/\\begin\s*\{multicols\}\s*\{(\d+)\}/g)) {
    if ((Number(multicol[1]) || 0) >= 4) return 'multicols environment with 4+ columns';
  }
  if (/\\begin\s*\{paracol\*?\}/.test(text)) return 'paracol environment';
  if (/\\documentclass\s*\[[^\]]*\btwocolumn\b[^\]]*\]/.test(text)) return 'twocolumn class option';
  if (/\\twocolumn\b/.test(text)) return '\\twocolumn command';
  return '';
}

function multicolBlockInfo(text) {
  const m = text.match(/\\begin\s*\{(multicols\*?)\}\s*\{(\d+)\}/);
  if (!m) return null;
  return { cols: Math.max(2, Math.min(20, Number(m[2]) || 2)), starred: m[1].endsWith('*') };
}

function paracolBlockInfo(text) {
  const m = text.match(/\\begin\s*\{paracol\*?\}\s*\{(\d+)\}/);
  if (!m) return null;
  return { cols: Math.max(2, Math.min(20, Number(m[1]) || 2)) };
}

function columnLayoutBlockInfo(text) {
  const mc = multicolBlockInfo(text);
  if (mc) return { layout: 'multicol', cols: mc.cols };
  const pc = paracolBlockInfo(text);
  if (pc) return { layout: 'paracol', cols: pc.cols };
  return null;
}

function forcesFullPageBreak(text) {
  return /\\(?:clearpage|cleardoublepage|onecolumn|twocolumn)\b/.test(text);
}

// Environment-aware source tree. A column environment (paracol/multicols) stays
// a single atomic block for typesetting — the resident daemon always receives
// the whole, compilable environment, never a broken fragment. On top of that
// atomic owner we expose independently editable *child regions*: each heading
// or paragraph inside the environment, carrying the column it belongs to.
//
// Editing a child never detaches it: a region edit rewrites a slice of the
// owner's source (via the region's document offsets) and the whole environment
// is re-typeset. This is the owner/continuation model — children are views into
// the owner, so no partial TeX ever reaches the daemon.
//
// paracol columns are known statically from \switchcolumn boundaries; multicols
// flows automatically, so its regions carry column=null and the column is
// resolved from glyph x at hitbox time.
function environmentChildren(block) {
  const info = columnLayoutBlockInfo(block.text);
  if (!info) return [];
  const open = /\\begin\s*\{(?:multicols\*?|paracol\*?)\}\s*(?:\[[^\]]*\])?\s*\{\d+\}/.exec(block.text);
  if (!open) return [];
  const innerStart = open.index + open[0].length;
  const close = /\\end\s*\{(?:multicols\*?|paracol\*?)\}/.exec(block.text.slice(innerStart));
  const innerEnd = close ? innerStart + close.index : block.text.length;
  const inner = block.text.slice(innerStart, innerEnd);
  if (!inner.trim()) return [];
  const segs = segmentBody(inner, innerStart);
  if (segs.length <= 1) return [];
  const switches = [];
  for (const sw of block.text.matchAll(/\\switchcolumn\*?/g)) {
    if (sw.index >= innerStart && sw.index < innerEnd) switches.push(sw.index);
  }
  const children = [];
  let n = 0;
  for (const s of segs) {
    // structural-only segments (\switchcolumn, stray \columnbreak) set no ink
    // and must not become editable regions
    if (!blockHasVisibleText(s.text)) continue;
    n++;
    const column =
      info.layout === 'paracol'
        ? switches.filter((off) => off < s.start).length % info.cols
        : null;
    children.push({
      id: `${block.id}.r${n}`,
      ownerId: block.id,
      start: block.start + s.start,
      end: block.start + s.end,
      text: s.text,
      hash: s.hash,
      column,
      cols: info.cols,
      layout: info.layout,
      kind: HEADING_RE.test(s.text) ? 'heading' : 'block',
    });
  }
  return children;
}

function dimBp(v) {
  return `${Math.max(0, Number(v) || 0).toFixed(6)}bp`;
}

function addMulticolHitboxes(commands, multicolBlocks, geo, leftEdge) {
  if (!multicolBlocks.size) return;
  const textwidth = geo.textwidth ?? 0;
  const columnsep = geo.columnsep ?? 10;
  if (!(textwidth > 0)) return;
  const boxes = new Map();
  for (const cmd of commands) {
    const info = cmd.src ? multicolBlocks.get(cmd.src) : null;
    if (!info || cmd.layout !== 'multicol') continue;
    const cols = info.cols;
    const colW = (textwidth - (cols - 1) * columnsep) / cols;
    if (!(colW > 0)) continue;
    const stride = colW + columnsep;
    const relX = (cmd.x ?? leftEdge) - leftEdge;
    const col = Math.max(0, Math.min(cols - 1, Math.floor((relX + columnsep / 2) / stride)));
    const key = `${cmd.src}:${col}`;
    let y0;
    let y1;
    if (cmd.op === 'glyphs') {
      const size = cmd.size ?? 10;
      y0 = (cmd.y ?? 0) - size;
      y1 = (cmd.y ?? 0) + size * 0.35;
    } else if (cmd.op === 'rule') {
      y0 = cmd.y ?? 0;
      y1 = (cmd.y ?? 0) + (cmd.h ?? 0);
    } else {
      continue;
    }
    const x0 = leftEdge + col * stride;
    const x1 = x0 + colW;
    const prev = boxes.get(key);
    if (prev) {
      prev.y0 = Math.min(prev.y0, y0);
      prev.y1 = Math.max(prev.y1, y1);
    } else {
      boxes.set(key, { src: cmd.src, col, x0, x1, y0, y1 });
    }
  }
  for (const box of boxes.values()) {
    if (!(box.y1 > box.y0)) continue;
    const padY = 4;
    commands.push({
      op: 'hitbox',
      src: box.src,
      layout: 'multicol',
      column: box.col,
      x: r2(box.x0),
      y: r2(Math.max(0, box.y0 - padY)),
      w: r2(box.x1 - box.x0),
      h: r2(box.y1 - box.y0 + 2 * padY),
    });
  }
}

function parsePdfBboxWords(xml) {
  const pages = [];
  const pageRe = /<page\b([^>]*)>([\s\S]*?)<\/page>/g;
  let pm;
  while ((pm = pageRe.exec(xml))) {
    const attrs = pm[1];
    const n = Number(attrs.match(/\bnumber="(\d+)"/)?.[1] ?? pages.length + 1);
    const words = [];
    const wordRe = /<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="([0-9.]+)" yMax="([0-9.]+)">([\s\S]*?)<\/word>/g;
    let wm;
    while ((wm = wordRe.exec(pm[2]))) {
      const text = decodeXmlText(wm[5]);
      const norm = normWord(text);
      if (!norm) continue;
      words.push({
        x0: Number(wm[1]),
        y0: Number(wm[2]),
        x1: Number(wm[3]),
        y1: Number(wm[4]),
        t: text,
        n: norm,
      });
    }
    pages.push({ n, words });
  }
  return pages;
}

// True when a block would set at least one visible glyph of its own: after
// stripping comments, control sequences and structural punctuation, some
// letter or digit remains. Blocks like \clearpage strip to nothing.
function blockHasVisibleText(text) {
  const stripped = String(text || '')
    .replace(/%[^\n]*/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/\\[^a-zA-Z]/g, ' ')
    .replace(/[{}[\]$^_~&#]/g, ' ');
  return /[0-9A-Za-z]/.test(stripped);
}

function significantTerms(tex) {
  const plain = tex
    .replace(/%[^\n]*/g, ' ')
    .replace(/\\(?:begin|end)\s*\{[^}]+\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])?/g, ' ')
    .replace(/[{}_$^~&#]/g, ' ');
  const out = new Set();
  for (const raw of plain.split(/[^0-9A-Za-z]+/)) {
    const w = normWord(raw);
    if (!w || STOP_WORDS.has(w)) continue;
    if (w.length < 4 && !/^\d+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'into', 'from', 'this', 'that',
  'here', 'there', 'page', 'text', 'will', 'should',
]);

function rectForWords(words, { trimOutliers = false, pageW = 612, pageH = 792 } = {}) {
  let use = words;
  if (trimOutliers && words.length >= 10) {
    const ys = words.map((w) => w.y0).sort((a, b) => a - b);
    const y0 = ys[Math.floor(ys.length * 0.05)];
    const y1 = ys[Math.ceil(ys.length * 0.95) - 1];
    use = words.filter((w) => w.y0 >= y0 && w.y0 <= y1);
  }
  if (!use.length) return null;
  const pad = 4;
  const x0 = Math.max(0, Math.min(...use.map((w) => w.x0)) - pad);
  const y0 = Math.max(0, Math.min(...use.map((w) => w.y0)) - pad);
  const x1 = Math.min(pageW, Math.max(...use.map((w) => w.x1)) + pad);
  const y1 = Math.min(pageH, Math.max(...use.map((w) => w.y1)) + pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function rectsForWords(words, opts = {}) {
  if (!words.length) return [];
  const rects = verticalWordClusters(words)
    .map((cluster) => rectForWords(cluster.words, opts))
    .filter(Boolean);
  if (rects.length) return rects;
  const rect = rectForWords(words, opts);
  return rect ? [rect] : [];
}

// Group full-page bbox words into per-column/paragraph boxes. The words' own
// horizontal span is divided into `cols` bands and each word is assigned to the
// band under its center. Within a column, large vertical gaps start a new box
// so the preview does not draw one huge blue outline across unrelated text.
function columnRectsForWords(words, cols, pageW = 612, pageH = 792) {
  if (!(cols >= 1) || !words.length) return [];
  const minX = Math.min(...words.map((w) => w.x0));
  const maxX = Math.max(...words.map((w) => w.x1));
  const span = maxX - minX;
  if (!(span > 0)) return [];
  const bandW = span / cols;
  const byCol = new Map();
  for (const w of words) {
    const cx = (w.x0 + w.x1) / 2;
    const col = Math.max(0, Math.min(cols - 1, Math.floor((cx - minX) / bandW)));
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push(w);
  }
  const pad = 4;
  const out = [];
  for (const [col, colWords] of [...byCol].sort((a, b) => a[0] - b[0])) {
    for (const r of verticalWordClusters(colWords)) {
      const x = Math.max(0, r.x0 - pad);
      const y = Math.max(0, r.y0 - pad);
      const x1 = Math.min(pageW, r.x1 + pad);
      const y1 = Math.min(pageH, r.y1 + pad);
      if (x1 <= x || y1 <= y) continue;
      out.push({ col, x, y, w: x1 - x, h: y1 - y });
    }
  }
  return out;
}

function verticalWordClusters(words) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const clusters = [];
  let cur = null;
  let lastY1 = -Infinity;
  for (const w of sorted) {
    const lineH = Math.max(4, w.y1 - w.y0);
    const gap = w.y0 - lastY1;
    if (!cur || gap > Math.max(18, lineH * 1.9)) {
      cur = { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, count: 0, words: [] };
      clusters.push(cur);
    } else {
      cur.x0 = Math.min(cur.x0, w.x0);
      cur.y0 = Math.min(cur.y0, w.y0);
      cur.x1 = Math.max(cur.x1, w.x1);
      cur.y1 = Math.max(cur.y1, w.y1);
    }
    cur.count++;
    cur.words.push(w);
    lastY1 = Math.max(lastY1, w.y1);
  }
  return clusters.filter((r) => r.count >= 2);
}

function instrumentPageLayoutPocSource(text, bounds, blocks, luaPath, metaPath, counters, shimPath) {
  let cursor = bounds.body.start;
  const body = [];
  for (const block of blocks) {
    body.push(text.slice(cursor, block.start));
    body.push(`\n\\directlua{tdom_poc_register_block('${luaStr(block.id)}',${block.index},${block.start},${block.end})}\n`);
    body.push(`\\special{tdom:poc:start:${block.id}}\n`);
    body.push(instrumentBlockRegions(block));
    body.push(`\n\\special{tdom:poc:end:${block.id}}\n`);
    cursor = block.end;
  }
  body.push(text.slice(cursor, bounds.body.end));
  const setup =
    `\n\\directlua{dofile('${luaStr(luaPath)}');tdom_poc_setup('${luaStr(metaPath)}',{` +
    counters.map((c) => `'${luaStr(c)}'`).join(',') +
    `},'${luaStr(shimPath)}')}\n`;
  return text.slice(0, bounds.body.start) + setup + body.join('') + text.slice(bounds.body.end);
}

// Splice region markers into a block's source at its child-region boundaries.
// The markers are \special whatsits (zero-dimension), so the shipped page is
// pixel-identical while every glyph inside a region is attributable to it.
function instrumentBlockRegions(block) {
  const children = block.children ?? [];
  if (!children.length) return block.text;
  const parts = [];
  let cursor = 0;
  for (const child of children) {
    const rs = child.start - block.start;
    const re = child.end - block.start;
    if (rs < cursor || re < rs || re > block.text.length) continue;
    parts.push(block.text.slice(cursor, rs));
    parts.push(`\n\\special{tdom:poc:rstart:${child.id}}\n`);
    parts.push(block.text.slice(rs, re));
    parts.push(`\n\\special{tdom:poc:rend:${child.id}}\n`);
    cursor = re;
  }
  parts.push(block.text.slice(cursor));
  return parts.join('');
}

function pageLayoutPocLuaSource() {
  return String.raw`
local OUT = nil
local COUNTERS = {}
local fk = nil
local pages = {}
local blocks = {}
local active_block = nil
local active_region = nil
local current_page = nil
local page_block_seen = nil

local SP2BP = 65781.76
local function bp(sp)
  return math.floor(((sp or 0) / SP2BP) * 1000000 + 0.5) / 1000000
end

local function jstr(s)
  s = tostring(s or '')
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', ''):gsub('\t', '\\t')
  s = s:gsub('[%z\1-\31]', '')
  return '"' .. s .. '"'
end

local function jenc(v)
  local t = type(v)
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return '0' end
    return string.format('%.10g', v)
  elseif t == 'boolean' then
    return tostring(v)
  elseif t == 'string' then
    return jstr(v)
  elseif t == 'table' then
    if v[1] ~= nil or next(v) == nil then
      local parts = {}
      for i = 1, #v do parts[#parts + 1] = jenc(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    else
      local parts = {}
      for k, val in pairs(v) do parts[#parts + 1] = jstr(k) .. ':' .. jenc(val) end
      return '{' .. table.concat(parts, ',') .. '}'
    end
  end
  return 'null'
end

function tdom_poc_register_block(id, index, start_offset, end_offset)
  blocks[id] = {
    id = id,
    index = tonumber(index) or 0,
    start = tonumber(start_offset) or 0,
    stop = tonumber(end_offset) or 0,
  }
end

local GLYPH = node.id('glyph')
local HLIST = node.id('hlist')
local VLIST = node.id('vlist')
local RULE = node.id('rule')
local GLUE = node.id('glue')
local KERN = node.id('kern')
local DISC = node.id('disc')
local WHATSIT = node.id('whatsit')
local SPECIAL_SUB = node.subtype and node.subtype('special')

local function note_block(id)
  if not id or not current_page then return end
  if not page_block_seen[id] then
    page_block_seen[id] = true
    current_page.blockIds[#current_page.blockIds + 1] = id
  end
end

local function check_marker(n)
  if not (n and WHATSIT and SPECIAL_SUB and n.id == WHATSIT and n.subtype == SPECIAL_SUB and n.data) then
    return false
  end
  local start_id = n.data:match('^tdom:poc:start:([%w_%-]+)$')
  if start_id then
    active_block = start_id
    active_region = nil
    note_block(active_block)
    return true
  end
  local end_id = n.data:match('^tdom:poc:end:([%w_%-]+)$')
  if end_id then
    note_block(end_id)
    if active_block == end_id then active_block = nil end
    active_region = nil
    return true
  end
  local rstart_id = n.data:match('^tdom:poc:rstart:([%w_%-%.]+)$')
  if rstart_id then
    active_region = rstart_id
    return true
  end
  local rend_id = n.data:match('^tdom:poc:rend:([%w_%-%.]+)$')
  if rend_id then
    if active_region == rend_id then active_region = nil end
    return true
  end
  return false
end

local walk_h, walk_v

local function emit_glyph(n, x, baseline)
  local ch = '?'
  local ok, s = pcall(function() return unicode.utf8.char(n.char or 63) end)
  if ok and s then ch = s end
  local f = font.getfont(n.font or 0) or {}
  local block = active_block
  if block then note_block(block) end
  current_page.glyphs[#current_page.glyphs + 1] = {
    block = block or '',
    region = active_region,
    text = ch,
    x = bp(x + (n.xoffset or 0)),
    y = bp(baseline - (n.yoffset or 0)),
    -- glyph metrics let the host reconstruct an exact ink box:
    -- [x, x+w] horizontally and [y-h, y+d] vertically (top-left page frame)
    w = bp(n.width or 0),
    h = bp(n.height or 0),
    d = bp(n.depth or 0),
    font = f.name or f.fullname or '',
    size = bp(f.size or 0),
  }
end

walk_h = function(head, parent, x0, baseline)
  local x = x0
  local n = head
  while n do
    local id = n.id
    if id == GLYPH then
      emit_glyph(n, x, baseline)
      x = x + (n.width or 0)
    elseif id == KERN then
      x = x + (n.kern or 0)
    elseif id == GLUE then
      x = x + (node.effective_glue(n, parent) or n.width or 0)
    elseif id == HLIST then
      walk_h(n.list, n, x, baseline + (n.shift or 0))
      x = x + (n.width or 0)
    elseif id == VLIST then
      walk_v(n, x, baseline + (n.shift or 0))
      x = x + (n.width or 0)
    elseif id == DISC then
      if n.replace then
        local fake = node.hpack(node.copy_list(n.replace))
        walk_h(fake.list, fake, x, baseline)
        x = x + (fake.width or 0)
        node.free(fake)
      end
    elseif id == WHATSIT then
      check_marker(n)
    elseif id == RULE then
      x = x + (n.width or 0)
    end
    n = n.next
  end
end

walk_v = function(box, x0, baseline)
  local y = baseline - (box.height or 0)
  local n = box.list
  while n do
    local id = n.id
    if id == HLIST then
      local base = y + (n.height or 0)
      walk_h(n.list, n, x0 + (n.shift or 0), base)
      y = y + (n.height or 0) + (n.depth or 0)
    elseif id == VLIST then
      walk_v(n, x0 + (n.shift or 0), y + (n.height or 0))
      y = y + (n.height or 0) + (n.depth or 0)
    elseif id == GLUE then
      y = y + (node.effective_glue(n, box) or n.width or 0)
    elseif id == KERN then
      y = y + (n.kern or 0)
    elseif id == RULE then
      y = y + (n.height or 0) + (n.depth or 0)
    elseif id == WHATSIT then
      check_marker(n)
    end
    n = n.next
  end
end

local function counter_value(name)
  local ok, v = pcall(function() return tex.count['c@' .. name] end)
  if ok and v ~= nil then return tonumber(v) or 0 end
  return nil
end

local function collect_state()
  local state = {
    shipoutIndex = #pages + 1,
    outputpenalty = tonumber(tex.outputpenalty or 0) or 0,
    pagetotal = bp(tex.pagetotal or 0),
    pagegoal = bp(tex.pagegoal or 0),
    deadcycles = tonumber(tex.deadcycles or 0) or 0,
    counters = {},
  }
  state.pageCounter = counter_value('page')
  for _, name in ipairs(COUNTERS) do
    local v = counter_value(name)
    if v ~= nil then state.counters[name] = v end
  end
  if fk then
    local ok, pid = pcall(function() return fk.fork() end)
    if ok and pid == 0 then
      fk._exit(0)
    elseif ok and pid then
      state.processSnapshot = { method = 'fork', pid = pid }
    else
      state.processSnapshot = { method = 'fork', error = tostring(pid) }
    end
  else
    state.processSnapshot = { method = 'unavailable' }
  end
  return state
end

local function block_range(ids)
  local first, last = nil, nil
  for _, id in ipairs(ids) do
    local b = blocks[id]
    if b then
      first = first and math.min(first, b.index) or b.index
      last = last and math.max(last, b.index) or b.index
    end
  end
  return { first = first or -1, last = last or -1 }
end

local function tdom_poc_shipout(head)
  current_page = {
    number = #pages + 1,
    state = collect_state(),
    blockIds = {},
    blockRange = { first = -1, last = -1 },
    glyphs = {},
  }
  page_block_seen = {}
  if active_block then note_block(active_block) end
  if head and (head.id == HLIST or head.id == VLIST) then
    walk_v(head, 0, head.height or 0)
  end
  table.sort(current_page.blockIds, function(a, b)
    local ai = blocks[a] and blocks[a].index or 0
    local bi = blocks[b] and blocks[b].index or 0
    return ai < bi
  end)
  current_page.blockRange = block_range(current_page.blockIds)
  pages[#pages + 1] = current_page
  current_page = nil
  page_block_seen = nil
  return head
end

local function tdom_poc_finish()
  local ordered = {}
  for _, b in pairs(blocks) do
    ordered[#ordered + 1] = {
      id = b.id,
      index = b.index,
      start = b.start,
      stop = b.stop,
    }
  end
  table.sort(ordered, function(a, b) return (a.index or 0) < (b.index or 0) end)
  local f = assert(io.open(OUT, 'w'))
  f:write(jenc({
    mode = 'normal-tex-pre-shipout-callback',
    normalTex = true,
    blocks = ordered,
    pages = pages,
  }))
  f:close()
end

function tdom_poc_setup(out, counters, shim_path)
  OUT = out
  COUNTERS = counters or {}
  if shim_path and shim_path ~= '' then
    local loader = package.loadlib(shim_path, 'luaopen_tdomfork')
    if loader then
      fk = loader()
      pcall(function() fk.ignore_sigchld() end)
    end
  end
  if luatexbase and luatexbase.add_to_callback then
    luatexbase.add_to_callback('pre_shipout_filter', tdom_poc_shipout, 'tdom page-layout poc')
    luatexbase.add_to_callback('finish_pdffile', tdom_poc_finish, 'tdom page-layout poc finish')
  else
    callback.register('pre_shipout_filter', tdom_poc_shipout)
    callback.register('finish_pdffile', tdom_poc_finish)
  end
end
`;
}

function normWord(s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-z]+/g, '');
}

function decodeXmlText(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function resolveFont(name) {
  try {
    return execFileSync('kpsewhich', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Normalize a pdftocairo page SVG to the exact box extent (bp): content is
 * anchored at the origin by the driver's \hoffset/\voffset, so setting the
 * viewBox crops precisely regardless of the page size the ship went out at.
 */
function cropSvg(svg, wBp, hBp) {
  return svg.replace(
    /<svg([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `<svg$1width="${wBp}pt" height="${hBp}pt" viewBox="0 0 ${wBp} ${hBp}"`
  );
}

/** Wait until a PDF file exists and ends with %%EOF (flushed completely). */
async function waitForPdf(p, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const buf = readFileSync(p);
      if (buf.length > 8 && buf.subarray(-32).toString('latin1').includes('%%EOF')) return;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('render child produced no complete PDF');
}

function luaStr(s) {
  return s.replace(/\\/g, '/').replace(/'/g, "\\'");
}

/** Net {…} depth of a block (comments stripped, \{ \} ignored). */
function braceImbalance(text) {
  let d = 0;
  for (const line of text.split('\n')) {
    let s = line;
    const ci = s.search(/(?<!\\)%/);
    if (ci >= 0) s = s.slice(0, ci);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '{') d++;
      else if (s[i] === '}') d--;
    }
  }
  return d;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
