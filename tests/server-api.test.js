import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const execFileP = promisify(execFile);

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startServer(t) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TDOM_BACKEND: 'internal' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
    const poll = setInterval(() => {
      if (output.includes('listening on')) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });
  t.after(() => {
    child.kill('SIGTERM');
  });
  return `http://127.0.0.1:${port}`;
}

async function hasLuaLatex() {
  try {
    await execFileP('lualatex', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

test('server stores, lists, and reads uploaded TeX files', async (t) => {
  const base = await startServer(t);
  const name = `server-api-${Date.now()}.tex`;
  const file = path.join(ROOT, 'samples', 'uploads', name);
  t.after(() => rmSync(file, { force: true }));

  const body = '\\section{API Preview}\\nSaved body.\\n';
  const save = await fetch(`${base}/texfiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text: body }),
  });
  assert.equal(save.status, 201);
  const saved = await save.json();
  assert.equal(saved.texPath, `uploads/${name}`);

  const list = await fetch(`${base}/texfiles`).then((res) => res.json());
  assert.ok(list.some((item) => item.texPath === saved.texPath));

  const read = await fetch(`${base}/texfiles/${encodeURIComponent(saved.texPath)}`);
  assert.equal(read.status, 200);
  const payload = await read.json();
  assert.equal(payload.text, body);
  assert.equal(payload.size, Buffer.byteLength(body, 'utf8'));
});

test('server compiles AI style previews to a real PDF when LuaLaTeX is available', { skip: !(await hasLuaLatex()) && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const source = String.raw`\documentclass{article}
\begin{document}
Style preview $E=mc^2$.
\end{document}
`;
  const res = await fetch(`${base}/ai-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  assert.equal(res.status, 201);
  const preview = await res.json();
  assert.match(preview.url, /^\/ai-preview\/[a-z0-9-]+\.pdf$/);

  const pdf = await fetch(`${base}${preview.url}`);
  assert.equal(pdf.status, 200);
  const head = Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1');
  assert.equal(head, '%PDF-');
});
