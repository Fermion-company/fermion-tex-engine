// Resident engine server.
//
// The TDOM engine lives in this process, holding the full document state
// between requests. Three interchangeable engines (TDOM_BACKEND=...):
//   - checkpoint (default with TeX installed): fork-checkpointed resident
//     lualatex — keystroke-synchronous live preview (~5ms edits) drawing
//     TeX's own glyphs with TeX's own fonts
//   - lualatex: per-block isolated compiles (v1 architecture)
//   - internal: the zero-dependency toy engine
//
// Clients are thin: the editor POSTs text deltas, the viewer applies
// display-list patches (from the POST response and/or the SSE stream).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TDOMEngine } from './engine/engine.js';
import { LuaTDOMEngine } from './engine/engine-lua.js';
import { LuaTexBackend } from './engine/luatex/backend.js';
import { CheckpointEngine } from './engine/checkpoint/engine-v3.js';
import { PAGE } from './engine/layout.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4633);

async function createEngine() {
  const pref = process.env.TDOM_BACKEND;
  const texAvailable = await LuaTexBackend.detect();
  if (pref === 'internal' || !texAvailable) {
    return {
      engine: new TDOMEngine(),
      backend: 'internal',
      sample: readFileSync(path.join(ROOT, 'samples', 'demo.tex'), 'utf8'),
    };
  }
  if (pref === 'lualatex') {
    return {
      engine: new LuaTDOMEngine({ workDir: path.join(ROOT, '.tdom-cache') }),
      backend: 'lualatex',
      sample: readFileSync(path.join(ROOT, 'samples', 'demo-lua.tex'), 'utf8'),
    };
  }
  return {
    engine: new CheckpointEngine({ workDir: path.join(ROOT, '.tdom-v3') }),
    backend: 'checkpoint',
    sample: readFileSync(path.join(ROOT, 'samples', 'demo-lua.tex'), 'utf8'),
  };
}

const { engine, backend, sample } = await createEngine();
let lastReport = await engine.open(sample);
console.log(
  `[tdom] engine resident (${backend}): ${lastReport.stats.pageCount} pages, ` +
    `${lastReport.stats.blocksTotal} blocks, initial build ${(lastReport.stats.totalUs / 1000).toFixed(0)}ms`
);

// Serialize all engine mutations (compiles can take a while).
let queue = Promise.resolve();
function withEngine(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const sseClients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(data);
}

// async patches (TikZ renders, late chain discoveries) from the checkpoint engine
if (backend === 'checkpoint') {
  engine.onAsyncPatches = (partial) => {
    broadcast({ kind: 'patches', rev: partial.rev, patches: partial.patches });
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, rel) {
  try {
    const file = path.join(ROOT, 'web', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function geometry() {
  if (backend === 'internal') return { paperwidth: PAGE.width, paperheight: PAGE.height };
  const g = engine.getGeometry();
  return g;
}

function docPayload() {
  return {
    backend,
    source: engine.getSource(),
    pages: engine.getDisplayLists(),
    geometry: geometry(),
    fonts: backend === 'checkpoint' ? engine.getFontManifest() : [],
    report: lastReport,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && (url.pathname === '/app.js' || url.pathname === '/style.css')) {
      return serveStatic(res, url.pathname.slice(1));
    }
    if (req.method === 'GET' && url.pathname === '/doc') return json(res, docPayload());
    if (req.method === 'GET' && url.pathname === '/dom') return json(res, engine.getDOM());
    if (req.method === 'GET' && url.pathname.startsWith('/chunk/')) {
      const id = url.pathname.slice('/chunk/'.length).replace(/\.svg$/, '');
      const svg = engine.getChunkSVG ? engine.getChunkSVG(id) : null;
      if (!svg) {
        res.writeHead(404);
        return res.end('unknown chunk');
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-cache', // chunk content changes under a stable block id
      });
      return res.end(svg);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/font/')) {
      const key = decodeURIComponent(url.pathname.slice('/font/'.length));
      const body = engine.getFontFile ? engine.getFontFile(key) : null;
      if (!body) {
        res.writeHead(404);
        return res.end('unknown font');
      }
      const type = key.endsWith('.ttf') ? 'font/ttf' : 'font/otf';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/pdf') {
      const pdf = await withEngine(() => engine.exportPDF());
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="tdom-export.pdf"',
      });
      return res.end(pdf);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/edit') {
      const body = JSON.parse(await readBody(req));
      const { start, end, text } = body;
      if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') {
        return json(res, { error: 'edit requires {start, end, text}' }, 400);
      }
      lastReport = await withEngine(() => engine.edit(start, end, text));
      broadcast({ kind: 'update', report: lastReport });
      return json(res, lastReport);
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      const raw = await readBody(req);
      let text = sample;
      if (raw) {
        const body = JSON.parse(raw);
        if (typeof body.text === 'string') text = body.text;
      }
      lastReport = await withEngine(() => engine.open(text));
      broadcast({ kind: 'reset' });
      return json(res, docPayload());
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[tdom] request error:', err);
    if (!res.headersSent) json(res, { error: String(err?.message || err) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tdom] Fermion TeX Engine (${backend}) listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', async () => {
  if (engine.close) await engine.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (engine.close) await engine.close();
  process.exit(0);
});
