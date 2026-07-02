// LuaTeX compile backend.
//
// Wraps a real lualatex installation as the typesetting service of the
// incremental engine. Responsibilities:
//   - preamble management: precompile the preamble into a .fmt via
//     mylatexformat (rebuilt only when the preamble changes; graceful
//     fallback to inline-preamble compiles when dumping fails)
//   - block compiles: typeset N dirty blocks in ONE lualatex run, each into
//     a tight single page + galley metrics (see linesplit.lua)
//   - state injection: counters and \newlabel values are injected per block
//     so isolated block compiles agree with the document-wide state
//   - PDF page -> SVG chunk conversion via pdftocairo
//   - full compiles of the entire source for PDF export
//
// Everything here is stateless per call except the format cache directory.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const LUA_SUPPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'linesplit.lua');

const COMPILE_TIMEOUT = 60_000;

// Counters injected/read around every block compile. Preamble-defined
// counters (\newcounter, \newtheorem) are added at prepare() time.
const BASE_COUNTERS = [
  'part', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];

export class LuaTexBackend {
  constructor(workDir) {
    this.workDir = workDir;
    mkdirSync(workDir, { recursive: true });
    this.fmtName = null; // jobname of the current format, or null
    this.preambleText = '';
    this.counters = [...BASE_COUNTERS];
    this.geometry = null;
    this.diagnostics = [];
  }

  static async detect() {
    try {
      await execFileP('lualatex', ['--version'], { timeout: 10_000 });
      await execFileP('pdftocairo', ['-v'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Called whenever the preamble changes. Dumps a format (best effort),
   * probes geometry, extracts preamble-defined counters.
   */
  async prepare(preambleText) {
    this.preambleText = preambleText;
    this.diagnostics = [];
    this.counters = [...BASE_COUNTERS, ...scanCounterDefs(preambleText)];

    // 1. try to dump a format
    this.fmtName = null;
    const fmtJob = 'tdomfmt';
    const fmtSrc = path.join(this.workDir, 'fmtsource.tex');
    writeFileSync(fmtSrc, preambleText + '\n\\begin{document}\n\\end{document}\n');
    try {
      await execFileP(
        'lualatex',
        ['-ini', '-interaction=nonstopmode', `-jobname=${fmtJob}`, '&lualatex', 'mylatexformat.ltx', 'fmtsource.tex'],
        { cwd: this.workDir, timeout: COMPILE_TIMEOUT }
      );
      if (existsSync(path.join(this.workDir, fmtJob + '.fmt'))) {
        this.fmtName = fmtJob;
      }
    } catch (err) {
      this.diagnostics.push('preamble format dump failed — falling back to inline preamble compiles');
    }

    // 2. probe geometry — the probe also ships a page, so it doubles as a
    // smoke test of the format (tikz/pgf formats are known to break the PDF
    // backend; if that happens we drop the format and inline the preamble).
    const probeSrc = [
      preambleText,
      '\\begin{document}',
      `\\directlua{dofile('${luaPath()}')}`,
      '\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in',
      "\\directlua{tdom_probe('probe.json')}",
      '\\setbox0=\\hbox{x}\\shipout\\box0',
      '\\end{document}',
      '',
    ].join('\n');
    writeFileSync(path.join(this.workDir, 'probe.tex'), probeSrc);
    const probeOk = await this.#tryProbe();
    if (!probeOk && this.fmtName) {
      this.diagnostics.push('precompiled format failed its smoke test — using inline preamble compiles');
      this.fmtName = null;
      const ok2 = await this.#tryProbe();
      if (!ok2) throw new Error('preamble does not compile: ' + excerptLog(this.workDir, 'probe.log'));
    } else if (!probeOk) {
      throw new Error('preamble does not compile: ' + excerptLog(this.workDir, 'probe.log'));
    }
    this.geometry = JSON.parse(readFileSync(path.join(this.workDir, 'probe.json'), 'utf8'));
    return { fmt: !!this.fmtName, geometry: this.geometry, counters: this.counters };
  }

  async #tryProbe() {
    rmSync(path.join(this.workDir, 'probe.pdf'), { force: true });
    rmSync(path.join(this.workDir, 'probe.json'), { force: true });
    try {
      await this.#runLatex('probe.tex');
    } catch {
      /* judged by outputs below */
    }
    return existsSync(path.join(this.workDir, 'probe.pdf')) && existsSync(path.join(this.workDir, 'probe.json'));
  }

  /**
   * Compile blocks. jobs: [{ id, text, entryState:{counter:val}, noindent }]
   * labels: Map key -> value string (for \ref resolution).
   * Returns Map id -> { page, wBp,hBp,dBp, items, exit, labels:[{key,val}], pdfPage }
   * plus { pdfPath } for chunk extraction, or per-job error info.
   */
  async compileBlocks(jobs, labels) {
    if (!jobs.length) return { results: new Map(), lualatexMs: 0 };
    const t0 = Date.now();
    const driver = this.#driverSource(jobs, labels);
    const drvPath = path.join(this.workDir, 'blocks.tex');
    writeFileSync(drvPath, driver);
    for (const f of ['blocks.pdf', 'blocksmeta.json', 'blocks.aux']) {
      rmSync(path.join(this.workDir, f), { force: true });
    }
    let runError = null;
    try {
      await this.#runLatex('blocks.tex');
    } catch (err) {
      runError = err;
    }
    const results = new Map();
    const metaPath = path.join(this.workDir, 'blocksmeta.json');
    const pdfPath = path.join(this.workDir, 'blocks.pdf');
    if (existsSync(metaPath) && existsSync(pdfPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const auxLabels = parseAuxLabels(path.join(this.workDir, 'blocks.aux'));
      for (const blk of meta.blocks) {
        if (!blk.page) continue;
        results.set(blk.id, {
          page: blk.page,
          wBp: blk.w,
          hBp: blk.h,
          dBp: blk.d,
          items: blk.items,
          entry: blk.entry,
          exit: blk.exit,
          labels: auxLabels.get(blk.id) ?? [],
        });
      }
    }
    // Jobs missing from results errored inside TeX.
    for (const job of jobs) {
      if (!results.has(job.id)) {
        results.set(job.id, { error: runError ? excerptLog(this.workDir, 'blocks.log') : 'block produced no output' });
      }
    }
    return { results, pdfPath, lualatexMs: Date.now() - t0 };
  }

  /** Convert one page of the block PDF to an SVG string. */
  async chunkSVG(pdfPath, page) {
    const out = path.join(this.workDir, `chunk-${page}.svg`);
    await execFileP('pdftocairo', ['-svg', '-f', String(page), '-l', String(page), pdfPath, out], {
      timeout: 30_000,
    });
    return readFileSync(out, 'utf8');
  }

  /** Full document compile (used for PDF export — the honest fallback). */
  async fullCompile(sourceText) {
    const p = path.join(this.workDir, 'full.tex');
    writeFileSync(p, sourceText);
    // two passes so \ref/aux settle, like latexmk would
    await this.#runLatex('full.tex', { noFmt: true, tolerant: true });
    await this.#runLatex('full.tex', { noFmt: true, tolerant: true });
    const pdf = path.join(this.workDir, 'full.pdf');
    if (!existsSync(pdf)) throw new Error('full compile produced no PDF: ' + excerptLog(this.workDir, 'full.log'));
    return pdf;
  }

  #driverSource(jobs, labels) {
    const L = [];
    L.push(this.preambleText.trimEnd());
    L.push('\\begin{document}');
    L.push(`\\directlua{dofile('${luaPath()}')}`);
    L.push('\\pagestyle{empty}');
    L.push('\\hoffset=-1in');
    L.push('\\voffset=-1in');
    L.push('\\makeatletter');
    // float shims: render figure/table inline (live mode has no float placement)
    L.push('\\renewenvironment{figure}[1][]{\\par\\addvspace{\\intextsep}\\def\\@captype{figure}\\noindent\\begin{minipage}{\\textwidth}\\centering}{\\end{minipage}\\par\\addvspace{\\intextsep}}');
    L.push('\\renewenvironment{table}[1][]{\\par\\addvspace{\\intextsep}\\def\\@captype{table}\\noindent\\begin{minipage}{\\textwidth}\\centering}{\\end{minipage}\\par\\addvspace{\\intextsep}}');
    // known labels (so \ref/\eqref resolve during isolated block compiles);
    // \newlabel is preamble-only, so define the r@... macros directly.
    for (const [key, val] of labels) {
      L.push(`\\global\\@namedef{r@${key}}{{${val.num}}{${val.page}}}`);
    }
    L.push('\\newbox\\TDOMbox');
    L.push('\\providecommand\\tdomblockmark[1]{}');
    for (const job of jobs) {
      const id = job.id;
      L.push(`\\directlua{tdom_begin_block('${id}')}`);
      L.push(`\\immediate\\write\\@auxout{\\string\\tdomblockmark{${id}}}`);
      // entryState === null lets counters chain naturally within this run
      // (used for full builds where blocks are compiled in document order).
      if (job.entryState) {
        for (const [name, val] of Object.entries(job.entryState)) {
          L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${val}}\\fi`);
        }
      }
      for (const name of this.counters) {
        L.push(`\\ifcsname c@${name}\\endcsname\\directlua{tdom_entry_state('${name}',\\number\\value{${name}})}\\fi`);
      }
      L.push(`\\setbox\\TDOMbox=\\vbox{\\hsize=\\textwidth`);
      if (job.noindent) L.push('\\noindent');
      L.push(job.text.trimEnd());
      L.push('\\par}');
      L.push('\\directlua{tdom_split(\\number\\TDOMbox)}');
      L.push('\\directlua{tdom_load_whole(\\number\\TDOMbox)}');
      L.push('\\shipout\\box255');
      for (const name of this.counters) {
        L.push(`\\ifcsname c@${name}\\endcsname\\directlua{tdom_state('${name}',\\number\\value{${name}})}\\fi`);
      }
    }
    L.push("\\directlua{tdom_finish('blocksmeta.json')}");
    L.push('\\makeatother');
    L.push('\\end{document}');
    L.push('');
    return L.join('\n');
  }

  async #runLatex(file, { noFmt = false, tolerant = false } = {}) {
    const args = ['-interaction=nonstopmode'];
    if (this.fmtName && !noFmt) args.push(`-fmt=${this.fmtName}`);
    args.push(file);
    try {
      await execFileP('lualatex', args, { cwd: this.workDir, timeout: COMPILE_TIMEOUT });
    } catch (err) {
      if (!tolerant) throw new Error('lualatex failed: ' + (err.code ?? err.message));
    }
  }
}

function luaPath() {
  // LuaTeX wants forward slashes; escape for the Lua string literal.
  return LUA_SUPPORT.replace(/\\/g, '/').replace(/'/g, "\\'");
}

function scanCounterDefs(preamble) {
  const out = [];
  const re = /\\newtheorem\*?\{([^}]+)\}|\\newcounter\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(preamble))) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * Parse block-attributed \newlabel entries from the aux file.
 * Returns Map blockId -> [{key, num, page}].
 */
function parseAuxLabels(auxPath) {
  const map = new Map();
  if (!existsSync(auxPath)) return map;
  const text = readFileSync(auxPath, 'utf8');
  let currentBlock = null;
  for (const line of text.split('\n')) {
    const mark = line.match(/\\tdomblockmark\{([^}]*)\}/);
    if (mark) {
      currentBlock = mark[1];
      if (!map.has(currentBlock)) map.set(currentBlock, []);
      continue;
    }
    const label = line.match(/\\newlabel\{([^}]*)\}\{\{([^}]*)\}\{([^}]*)\}/);
    if (label && currentBlock) {
      map.get(currentBlock).push({ key: label[1], num: label[2], page: label[3] });
    }
  }
  return map;
}

function excerptLog(dir, logFile) {
  try {
    const log = readFileSync(path.join(dir, logFile), 'utf8');
    const lines = log.split('\n');
    const errIdx = lines.findIndex((l) => l.startsWith('! '));
    if (errIdx >= 0) return lines.slice(errIdx, errIdx + 3).join(' ');
    return 'compile failed (see ' + logFile + ')';
  } catch {
    return 'compile failed';
  }
}
