// Side-by-side dump: engine page lines vs real-PDF lines, plus raw stream.
// usage: node tools/debug-layout.mjs <file.tex> [--page=1] [--stream] [--truth=<dir>]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const execFileP = promisify(execFile);
const args = process.argv.slice(2);
const texFile = args.find((a) => !a.startsWith('--'));
const PAGE = Number((args.find((a) => a.startsWith('--page=')) ?? '--page=1').slice(7));
const SHOW_STREAM = args.includes('--stream');

const texPath = path.resolve(texFile);
const texSource = readFileSync(texPath, 'utf8');
const scratch = path.join(os.tmpdir(), 'tdom-debug');
mkdirSync(scratch, { recursive: true });

const engine = new CheckpointEngine({
  workDir: path.join(scratch, 'engine'),
  docDir: path.dirname(texPath),
});
await engine.open(texSource);
await engine.bgTask.catch(() => {});

if (SHOW_STREAM) {
  for (const block of engine.blocks) {
    console.log(`--- block ${block.id} (${block.kind}) gfx=${block.gfx}`);
    for (const e of block.units ?? []) {
      if (e.t === 'box') {
        const txt = (e.u.ln.runs ?? []).filter((r) => r.t).map((r) => r.t).join('').slice(0, 60);
        console.log(`  box h=${e.u.h.toFixed(2)} d=${e.u.d.toFixed(2)} "${txt}"`);
      } else if (e.t === 'glue') {
        console.log(`  glue a=${e.a} st=${e.st}@${e.sto} sh=${e.sh} sub=${e.sub}`);
      } else if (e.t === 'pen') {
        console.log(`  pen ${e.v}`);
      } else if (e.t === 'kern') {
        console.log(`  kern ${e.a}`);
      } else if (e.t === 'ins') {
        console.log(`  ins h=${e.h} hc=${e.hc} units=${e.units.length}`);
      } else {
        console.log(`  ${e.t} ${JSON.stringify({ ...e, f: e.f ? e.f.id : undefined })}`);
      }
    }
  }
}

// engine lines for PAGE
const dls = engine.getDisplayLists();
const dl = dls[PAGE - 1];
const eng = [];
if (dl) {
  for (const cmd of dl.commands) {
    if (cmd.op === 'glyphs') eng.push({ y: cmd.y, x: cmd.x, text: cmd.text.slice(0, 40) });
    else if (cmd.op === 'rule') eng.push({ y: cmd.y, x: cmd.x, text: `<rule w=${cmd.w} h=${cmd.h}>` });
    else if (cmd.op === 'chunk') eng.push({ y: cmd.y, x: cmd.x, text: `<chunk ${cmd.chunk} h=${cmd.h}>` });
    else if (cmd.op === 'folio') eng.push({ y: cmd.y, x: cmd.x, text: `<folio ${cmd.text}>` });
  }
}
const engLines = new Map();
for (const g of eng) {
  const key = Math.round(g.y * 50) / 50;
  if (!engLines.has(key)) engLines.set(key, g);
}

// truth lines
const dir = path.join(scratch, 'truth-' + path.basename(texPath, '.tex'));
mkdirSync(dir, { recursive: true });
const mainTex = path.join(dir, 'main.tex');
const prev = existsSync(mainTex) ? readFileSync(mainTex, 'utf8') : null;
if (prev !== texSource || !existsSync(path.join(dir, 'main.pdf'))) {
  writeFileSync(mainTex, texSource);
  const run = () =>
    execFileP('lualatex', ['-interaction=nonstopmode', 'main.tex'], { cwd: dir, timeout: 180_000 }).catch(() => {});
  await run();
  await run();
}
const svg = path.join(dir, `p${PAGE}.svg`);
execFileSync('pdftocairo', ['-svg', '-f', String(PAGE), '-l', String(PAGE), path.join(dir, 'main.pdf'), svg]);
const svgText = readFileSync(svg, 'utf8');
const truth = [];
{
  const re = /<use xlink:href="#glyph[^"]*" x="([-\d.]+)" y="([-\d.]+)"\/>/g;
  let m;
  while ((m = re.exec(svgText))) truth.push({ x: Number(m[1]), y: Number(m[2]) });
}
const tLines = new Map();
for (const g of truth) {
  const key = Math.round(g.y * 50) / 50;
  const cur = tLines.get(key);
  if (!cur || g.x < cur.x) tLines.set(key, { y: key, x: g.x, n: (cur?.n ?? 0) + 1 });
  else cur.n++;
}

const eArr = [...engLines.values()].sort((a, b) => a.y - b.y);
const tArr = [...tLines.values()].sort((a, b) => a.y - b.y);
console.log(`\n=== page ${PAGE}: engine ${eArr.length} lines vs truth ${tArr.length} lines`);
const n = Math.max(eArr.length, tArr.length);
for (let i = 0; i < n; i++) {
  const e = eArr[i];
  const t = tArr[i];
  const dy = e && t ? (e.y - t.y).toFixed(2) : '—';
  console.log(
    `${String(i).padStart(2)} eng ${e ? e.y.toFixed(2).padStart(7) + ' x' + e.x.toFixed(1).padStart(6) : '        —      '} | ` +
      `pdf ${t ? t.y.toFixed(2).padStart(7) + ' x' + t.x.toFixed(1).padStart(6) : '        —      '} | dy=${dy} ${e ? '"' + (e.text ?? '') + '"' : ''}`
  );
}
await engine.close();
process.exit(0);
