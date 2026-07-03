// Thin client for the Fermion TeX Engine.
//
// The editor sends text deltas; the viewer applies display-list patches; the
// inspector renders the engine's dirty report. All typesetting intelligence
// lives in the resident engine process — this file only draws.
//
// Two display-list dialects:
//   - internal backend: glyphs/rule commands -> SVG text pages
//   - lualatex backend: chunk commands (per-block SVG images produced by a
//     real LuaTeX) composed with clip windows + a folio number

const editor = document.getElementById('editor');
const pagesEl = document.getElementById('pages');
const statusEl = document.getElementById('status');
const inspectorEl = document.getElementById('inspector');

const FONT_FAMILY = {
  regular: `'Times New Roman', Times, serif`,
  italic: `'Times New Roman', Times, serif`,
  bold: `'Times New Roman', Times, serif`,
  bolditalic: `'Times New Roman', Times, serif`,
  mono: `'Courier New', Courier, monospace`,
};

let geometry = { paperwidth: 612, paperheight: 792 };
let backend = 'internal';
const loadedFonts = new Set();

function injectFonts(keys) {
  const missing = (keys ?? []).filter((k) => !loadedFonts.has(k));
  if (!missing.length) return;
  const css = missing
    .map(
      (k) =>
        `@font-face{font-family:'${k}';src:url('/font/${encodeURIComponent(k)}');font-display:block;}`
    )
    .join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  for (const k of missing) loadedFonts.add(k);
}
let serverText = '';
let appliedRev = 0;
let composing = false;
let sending = Promise.resolve();
let debounceTimer = null;
let inFlight = false;
const history = [];
const pageDivs = new Map();

// ---------------------------------------------------------------- boot

async function boot() {
  const doc = await fetch('/doc').then((r) => r.json());
  adoptDoc(doc);
  const ms = (doc.report.stats.totalUs / 1000).toFixed(0);
  statusEl.textContent =
    `常駐開始 [${backend}] — 初回フルビルド ${ms} ms / ${doc.report.stats.pageCount} pages / ` +
    `${doc.report.stats.blocksTotal} blocks（以後は差分のみ）`;
  renderInspector(doc.report, null);
}

function adoptDoc(doc) {
  geometry = doc.geometry;
  backend = doc.backend ?? 'internal';
  injectFonts(doc.fonts);
  serverText = doc.source;
  editor.value = doc.source;
  pagesEl.textContent = '';
  pageDivs.clear();
  for (const dl of doc.pages) renderPage(dl, false);
  appliedRev = doc.report.rev;
}

// ---------------------------------------------------------------- pages

function renderPage(dl, flash) {
  let div = pageDivs.get(dl.page);
  if (!div) {
    div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = dl.page;
    const no = document.createElement('span');
    no.className = 'pageno';
    no.textContent = `page ${dl.page}`;
    div.appendChild(no);
    const after = [...pageDivs.entries()].filter(([n]) => n > dl.page).sort((a, b) => a[0] - b[0])[0];
    pagesEl.insertBefore(div, after ? after[1] : null);
    pageDivs.set(dl.page, div);
  }
  div.querySelector('svg')?.remove();
  div.querySelector('.sheet')?.remove();
  div.querySelectorAll('.chunkwin').forEach((e) => e.remove());

  // checkpoint / internal display lists carry glyph runs -> unified SVG
  // plus absolutely-positioned <img> overlays for exact-render chunks;
  // lualatex (v1) pages are chunk-image compositions -> HTML sheet
  const hasGlyphs = dl.commands.some((c) => c.op === 'glyphs');
  if (hasGlyphs || backend !== 'lualatex') {
    div.insertAdjacentHTML('beforeend', svgFor(dl));
    for (const cmd of dl.commands) {
      if (cmd.op !== 'chunk') continue;
      const W = geometry.paperwidth;
      const H = geometry.paperheight;
      const shiftPct = (cmd.sy / cmd.w) * 100; // margin-top % is width-relative
      div.insertAdjacentHTML(
        'beforeend',
        `<div class="chunkwin" data-src="${cmd.src}" style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%">` +
          `<img class="chunk" src="/chunk/${cmd.chunk}.svg?v=${cmd.cv ?? 0}" style="margin-top:-${shiftPct}%" draggable="false"></div>`
      );
    }
  } else {
    div.insertAdjacentHTML('beforeend', chunkSheet(dl));
  }

  if (flash) {
    div.classList.remove('fading');
    div.classList.add('patched');
    requestAnimationFrame(() => div.classList.add('fading'));
    setTimeout(() => div.classList.remove('patched', 'fading'), 1200);
  }
}

/** lualatex mode: compose per-block chunk SVGs with clip windows. */
function chunkSheet(dl) {
  const W = geometry.paperwidth;
  const H = geometry.paperheight;
  const parts = [`<div class="sheet" style="aspect-ratio:${W}/${H}">`];
  for (const cmd of dl.commands) {
    if (cmd.op === 'chunk') {
      const left = (cmd.x / W) * 100;
      const top = (cmd.y / H) * 100;
      const width = (cmd.w / W) * 100;
      const height = (cmd.h / H) * 100;
      // margin-top % is relative to the WRAPPER WIDTH, so divide by chunk width
      const shift = (cmd.sy / cmd.w) * 100;
      parts.push(
        `<div class="chunkwin" data-src="${cmd.src}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">` +
          `<img class="chunk" src="/chunk/${cmd.chunk}.svg" style="margin-top:-${shift}%" draggable="false">` +
          `</div>`
      );
    } else if (cmd.op === 'folio') {
      parts.push(
        `<div class="folio" style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%">${escapeHtml(cmd.text)}</div>`
      );
    }
  }
  parts.push('</div>');
  return parts.join('');
}

/** Unified SVG page: TeX-positioned glyph runs, rules, chunk images, folio. */
function svgFor(dl) {
  const parts = [
    `<svg viewBox="0 0 ${geometry.paperwidth} ${geometry.paperheight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
  ];
  for (const cmd of dl.commands) {
    if (cmd.op === 'glyphs') {
      let fontAttrs;
      if (cmd.fam) {
        // checkpoint backend: real TeX font, TeX positions; disable browser
        // shaping so run-start x + font advances reproduce TeX exactly
        fontAttrs = ` font-family="${escapeXml(cmd.fam)}" style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"`;
      } else {
        const it = cmd.font === 'italic' || cmd.font === 'bolditalic' ? ` font-style="italic"` : '';
        const b = cmd.font === 'bold' || cmd.font === 'bolditalic' ? ` font-weight="bold"` : '';
        fontAttrs = ` font-family="${FONT_FAMILY[cmd.font] || FONT_FAMILY.regular}"${it}${b}`;
      }
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}" xml:space="preserve">${escapeXml(cmd.text)}</text>`
      );
    } else if (cmd.op === 'rule') {
      parts.push(
        `<rect x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.1)}" height="${Math.max(cmd.h, 0.1)}" fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}"/>`
      );
    } else if (cmd.op === 'chunk') {
      // exact-render chunks are drawn as HTML <img> overlays (see renderPage)
    } else if (cmd.op === 'folio') {
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="10" font-family="${FONT_FAMILY.regular}" fill="#1a1a1a" text-anchor="middle">${escapeXml(cmd.text)}</text>`
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function removePagesFrom(from) {
  for (const [n, div] of [...pageDivs.entries()]) {
    if (n >= from) {
      div.remove();
      pageDivs.delete(n);
    }
  }
}

function applyReport(report) {
  if (report.rev <= appliedRev) return;
  appliedRev = report.rev;
  for (const patch of report.patches) {
    if (patch.type === 'replace-page') renderPage(patch.displayList, true);
    else if (patch.type === 'remove-pages') removePagesFrom(patch.from);
  }
}

// ---------------------------------------------------------------- editing

function diffText(oldStr, newStr) {
  if (oldStr === newStr) return null;
  let start = 0;
  const maxStart = Math.min(oldStr.length, newStr.length);
  while (start < maxStart && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { start, end: endOld, text: newStr.slice(start, endNew) };
}

function scheduleSync() {
  if (backend === 'lualatex') {
    // per-block compiles cost ~0.5s: coalesce keystrokes
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushSync, 300);
    return;
  }
  // checkpoint/internal engines absorb every keystroke: send immediately —
  // the serialized `sending` chain coalesces bursts into single diffs
  flushSync();
}

function flushSync() {
  sending = sending.then(async () => {
    const current = editor.value;
    const d = diffText(serverText, current);
    if (!d) return;
    const t0 = performance.now();
    inFlight = true;
    if (backend === 'lualatex') statusEl.textContent = '組版中… (lualatex)';
    try {
      const res = await fetch('/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      const report = await res.json();
      if (report.error) throw new Error(report.error);
      serverText = current;
      const rtt = performance.now() - t0;
      applyReport(report);
      repositionBox();
      renderInspector(report, rtt);
      const engineMs =
        backend === 'checkpoint'
          ? `組版 ${report.stats.typesetMs ?? 0} ms / 全体 ${fmtUs(report.stats.totalUs)}`
          : backend === 'lualatex'
            ? `lualatex ${report.stats.lualatexMs ?? 0} ms / 全体 ${fmtUs(report.stats.totalUs)}`
            : `engine ${fmtUs(report.stats.totalUs)}`;
      statusEl.textContent =
        `update #${report.rev} [${backend}] — ${engineMs} / 往復 ${rtt.toFixed(0)} ms` +
        (report.dirtyPages.length
          ? ` / patched pages: ${report.dirtyPages.join(', ')}`
          : ' / 表示差分なし');
    } catch (err) {
      statusEl.textContent = `エラー: ${err.message}`;
    } finally {
      inFlight = false;
    }
  });
}

editor.addEventListener('compositionstart', () => (composing = true));
editor.addEventListener('compositionend', () => {
  composing = false;
  scheduleSync();
});
editor.addEventListener('input', () => {
  if (!composing) scheduleSync();
});

// Preview interactions:
//   click     -> PowerPoint-style box editing right on the page
//   Alt+click -> jump to the source in the left editor (legacy behavior)
pagesEl.addEventListener('click', async (ev) => {
  const src = srcOf(ev.target);
  if (!src) return;
  if (ev.altKey) {
    const dom = await fetch('/dom').then((r) => r.json());
    const block = dom.blocks.find((b) => b.id === src);
    if (!block) return;
    const offset = lineColToOffset(editor.value, block.source.start.line, block.source.start.column);
    editor.focus();
    editor.setSelectionRange(offset, offset);
    const lineTop = editor.value.slice(0, offset).split('\n').length - 1;
    editor.scrollTop = Math.max(0, lineTop * 19 - editor.clientHeight / 2);
    statusEl.textContent = `ソース対応: ${src} → main.tex:${block.source.start.line} (${block.type})`;
    return;
  }
  openBox(src);
});

function lineColToOffset(text, line, col) {
  let off = 0;
  let l = 1;
  while (l < line) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) break;
    off = nl + 1;
    l++;
  }
  return off + col - 1;
}

// ---------------------------------------------------------------- buttons

// ---------------------------------------------------------------- zoom

let zoom = Number(localStorage.getItem('tdom-zoom')) || 1;

function setZoom(z) {
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 100) / 100));
  pagesEl.style.setProperty('--zoom', zoom);
  document.getElementById('zoom-level').textContent = Math.round(zoom * 100) + '%';
  localStorage.setItem('tdom-zoom', String(zoom));
}

document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom * 1.1));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom / 1.1));
document.getElementById('zoom-fit').addEventListener('click', () => setZoom(1));

// PDF-viewer convention: Ctrl/Cmd + wheel (and trackpad pinch, which the
// browser reports as a ctrlKey wheel) zooms the document. The factor is
// proportional to the wheel delta: pinch gestures emit many small deltas,
// so a fixed per-event step feels far too aggressive.
pagesEl.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16; // line mode -> approx pixels
    const factor = Math.min(1.25, Math.max(1 / 1.25, Math.exp(-dy * 0.0035)));
    setZoom(zoom * factor);
  },
  { passive: false }
);

setZoom(zoom);


// ------------------------------------------------- PPT-style box editing
//
// Every block (paragraph, heading, equation, caption...) is an editable
// region: hovering outlines it, clicking opens an overlay editor holding
// exactly that block's source slice. Each keystroke rebuilds the main
// buffer and rides the normal 40ms edit pipeline, so the page reflows
// around the box as you type.

const hoverBox = document.createElement('div');
hoverBox.id = 'hoverbox';
let boxState = null; // {src, start, len, wrap, ta, pageDiv, closing}
let boxComposing = false;

function srcOf(target) {
  const src = target?.dataset?.src ?? target?.closest?.('[data-src]')?.dataset?.src;
  if (!src || src.startsWith('_')) return null;
  return src;
}

function blockRect(pageDiv, src) {
  const els = pageDiv.querySelectorAll(`[data-src="${src}"]`);
  if (!els.length) return null;
  const p = pageDiv.getBoundingClientRect();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const q = el.getBoundingClientRect();
    if (q.width === 0 && q.height === 0) continue;
    l = Math.min(l, q.left); t = Math.min(t, q.top);
    r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  if (!isFinite(l)) return null;
  const pad = 5;
  return {
    left: ((l - p.left - pad) / p.width) * 100,
    top: ((t - p.top - pad) / p.height) * 100,
    width: ((r - l + 2 * pad) / p.width) * 100,
    height: ((b - t + 2 * pad) / p.height) * 100,
  };
}

pagesEl.addEventListener('mousemove', (ev) => {
  if (boxState) return;
  const src = srcOf(ev.target);
  const pageDiv = ev.target?.closest?.('.page');
  if (!src || !pageDiv) { hoverBox.style.display = 'none'; return; }
  const rect = blockRect(pageDiv, src);
  if (!rect) { hoverBox.style.display = 'none'; return; }
  if (hoverBox.parentElement !== pageDiv) pageDiv.appendChild(hoverBox);
  Object.assign(hoverBox.style, {
    display: 'block',
    left: rect.left + '%',
    top: rect.top + '%',
    width: rect.width + '%',
    height: rect.height + '%',
  });
});
pagesEl.addEventListener('mouseleave', () => { if (!boxState) hoverBox.style.display = 'none'; });

async function openBox(src) {
  closeBox();
  const dom = await fetch('/dom').then((r) => r.json());
  const block = dom.blocks.find((b) => b.id === src);
  if (!block) return;
  if (block.file || !block.span) {
    statusEl.textContent = 'このブロックは \\input ファイル由来のため、ここでは編集できません';
    return;
  }
  const pageDiv = [...document.querySelectorAll('.page')].find((d) =>
    d.querySelector(`[data-src="${src}"]`)
  );
  if (!pageDiv) return;
  const rect = blockRect(pageDiv, src);
  if (!rect) return;
  hoverBox.style.display = 'none';

  const start = block.span.start;
  const slice = editor.value.slice(start, block.span.end);
  const wrap = document.createElement('div');
  wrap.className = 'boxedit';
  Object.assign(wrap.style, {
    left: rect.left + '%',
    top: rect.top + '%',
    width: Math.max(rect.width, 24) + '%',
  });
  const ta = document.createElement('textarea');
  ta.value = slice;
  ta.spellcheck = false;
  const hint = document.createElement('div');
  hint.className = 'boxhint';
  hint.textContent = 'Esc / 枠外クリックで確定';
  wrap.appendChild(ta);
  wrap.appendChild(hint);
  wrap.addEventListener('mousedown', (ev) => ev.stopPropagation());
  wrap.addEventListener('click', (ev) => ev.stopPropagation());
  pageDiv.appendChild(wrap);

  boxState = { src, start, len: slice.length, wrap, ta, pageDiv, closing: null };
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
  };
  grow();
  ta.focus();
  ta.setSelectionRange(0, 0);

  ta.addEventListener('compositionstart', () => (boxComposing = true));
  ta.addEventListener('compositionend', () => { boxComposing = false; onBoxInput(); });
  ta.addEventListener('input', () => { grow(); if (!boxComposing) onBoxInput(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeBox(); }
  });
  ta.addEventListener('blur', () => {
    boxState && (boxState.closing = setTimeout(closeBox, 140));
  });
  ta.addEventListener('focus', () => {
    if (boxState?.closing) { clearTimeout(boxState.closing); boxState.closing = null; }
  });
}

function onBoxInput() {
  if (!boxState) return;
  const s = boxState;
  const next = s.ta.value;
  editor.value = editor.value.slice(0, s.start) + next + editor.value.slice(s.start + s.len);
  s.len = next.length;
  scheduleSync();
}

function closeBox() {
  if (!boxState) return;
  const s = boxState;
  boxState = null;
  if (s.closing) clearTimeout(s.closing);
  s.wrap.remove();
}

// After patches land, re-anchor the open box to the block's new position
// (it may have reflowed or moved to another page); close it gracefully if
// the block id no longer exists (e.g. the edit split the block in two).
function repositionBox() {
  if (!boxState) return;
  const s = boxState;
  const pageDiv = [...document.querySelectorAll('.page')].find((d) =>
    d.querySelector(`[data-src="${s.src}"]`)
  );
  if (!pageDiv) { closeBox(); return; }
  const rect = blockRect(pageDiv, s.src);
  if (!rect) { closeBox(); return; }
  if (s.wrap.parentElement !== pageDiv) pageDiv.appendChild(s.wrap);
  s.wrap.style.left = rect.left + '%';
  s.wrap.style.top = rect.top + '%';
  s.pageDiv = pageDiv;
}

// Template picker: start a fresh document from templates/*.tex
async function loadTemplateList() {
  try {
    const list = await fetch('/templates').then((r) => r.json());
    const sel = document.getElementById('tpl-select');
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      opt.title = t.desc;
      sel.appendChild(opt);
    }
    const demo = document.createElement('option');
    demo.value = '__demo';
    demo.textContent = 'デモ文書';
    sel.appendChild(demo);
  } catch {
    /* templates are optional */
  }
}

document.getElementById('tpl-select').addEventListener('change', async (ev) => {
  const id = ev.target.value;
  ev.target.value = '';
  if (!id) return;
  if (!confirm('現在の内容を破棄してテンプレートから新規作成しますか？')) return;
  const body = id === '__demo' ? '{}' : JSON.stringify({ template: id });
  const res = await fetch('/open', { method: 'POST', body });
  const doc = await res.json();
  if (doc.error) {
    statusEl.textContent = `エラー: ${doc.error}`;
    return;
  }
  adoptDoc(doc);
  history.length = 0;
  renderInspector(doc.report, null);
  statusEl.textContent = `テンプレート「${id}」から開始 — ${doc.report.stats.pageCount} pages`;
});

document.getElementById('btn-pdf').addEventListener('click', () => {
  statusEl.textContent = backend === 'lualatex' ? 'PDF生成中（フルコンパイル）…' : 'PDF生成中…';
  window.open('/pdf', '_blank');
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  const doc = await fetch('/open', { method: 'POST', body: '{}' }).then((r) => r.json());
  adoptDoc(doc);
  history.length = 0;
  renderInspector(doc.report, null);
  statusEl.textContent = 'サンプル文書に戻しました';
});

// ---------------------------------------------------------------- inspector

function fmtUs(us) {
  return us < 1000 ? `${us} µs` : `${(us / 1000).toFixed(2)} ms`;
}

function chips(list, cls = '') {
  if (!list || list.length === 0) return `<span class="chip none">—</span>`;
  const MAX = 14;
  const shown = list.slice(0, MAX).map((x) => `<span class="chip ${cls}">${escapeHtml(String(x))}</span>`);
  if (list.length > MAX) shown.push(`<span class="chip none">+${list.length - MAX}</span>`);
  return shown.join('');
}

function renderInspector(report, rtt) {
  const s = report.stats;
  const deps = report.dirtyDependencies.map((d) => `${d.kind}:${d.key} → ${d.affected.join(', ')}`);
  const phases = Object.entries(s)
    .filter(([k, v]) => k.endsWith('Us') && k !== 'totalUs' && typeof v === 'number')
    .map(([k, v]) => [k.slice(0, -2), v]);
  const maxUs = Math.max(...phases.map((p) => p[1]), 1);

  if (report.edit !== 'open') {
    history.unshift({ rev: report.rev, edit: report.edit, pages: report.dirtyPages, us: s.totalUs });
    if (history.length > 8) history.pop();
  }

  const isLua = backend === 'lualatex';
  const isCkpt = backend === 'checkpoint';
  const cacheRows = isCkpt
    ? `
        <span class="k">ブロック総数</span><span class="v">${s.blocksTotal}</span>
        <span class="k">fork再開組版</span><span class="v">${s.blocksTypeset}</span>
        <span class="k">ブロック再利用</span><span class="v good">${s.blocksTotal - s.blocksTypeset}</span>
        <span class="k">組版時間 (実TeX)</span><span class="v good">${s.typesetMs} ms</span>
        <span class="k">常駐チェックポイント</span><span class="v">${s.checkpoints}</span>
        <span class="k">フル再構築</span><span class="v">${s.rebooted ? 'あり（プリアンブル変更）' : 'なし'}</span>
        <span class="k">ページ再利用</span><span class="v good">${s.pagesReused} / ${s.pageCount}</span>
        <span class="k">ページ再構築</span><span class="v">${s.pagesRebuilt}</span>`
    : isLua
    ? `
        <span class="k">ブロック総数</span><span class="v">${s.blocksTotal}</span>
        <span class="k">lualatex再コンパイル</span><span class="v">${s.blocksCompiled}</span>
        <span class="k">ブロック再利用</span><span class="v good">${s.blocksTotal - s.blocksCompiled}</span>
        <span class="k">チャンクキャッシュヒット</span><span class="v good">${s.chunkCacheHits}</span>
        <span class="k">lualatex時間</span><span class="v">${s.lualatexMs} ms</span>
        <span class="k">SVG変換時間</span><span class="v">${s.svgMs} ms</span>
        <span class="k">format再構築</span><span class="v">${s.fmtRebuilt ? 'あり' : 'なし'}</span>
        <span class="k">ページ再利用</span><span class="v good">${s.pagesReused} / ${s.pageCount}</span>
        <span class="k">ページ再構築</span><span class="v">${s.pagesRebuilt}</span>`
    : `
        <span class="k">ブロック総数</span><span class="v">${s.blocksTotal}</span>
        <span class="k">再パース（展開+意味）</span><span class="v">${s.blocksReparsed}</span>
        <span class="k">展開キャッシュ再利用</span><span class="v good">${s.semanticCacheHits}</span>
        <span class="k">レイアウト再計算</span><span class="v">${s.layoutCacheMisses}</span>
        <span class="k">レイアウトキャッシュヒット</span><span class="v good">${s.layoutCacheHits}</span>
        <span class="k">ページ再利用</span><span class="v good">${s.pagesReused} / ${s.pageCount}</span>
        <span class="k">ページ再構築</span><span class="v">${s.pagesRebuilt}</span>`;

  inspectorEl.innerHTML = `
    <div class="card">
      <div class="bigtime">${fmtUs(s.totalUs)} <span class="unit">${isCkpt ? 'checkpoint engine (常駐TeX)' : isLua ? 'lualatex backend' : 'internal engine'}${rtt != null ? ` / 往復 ${rtt.toFixed(0)} ms` : ''}</span></div>
      <div class="editlabel">edit: ${escapeHtml(report.edit)} (rev ${report.rev})</div>
    </div>

    <div class="card">
      <h3>Dirty 伝播チェーン</h3>
      <div class="chainrow"><span class="lbl">Source</span><span class="chips">${chips(report.dirtySourceNodes)}</span></div>
      <div class="chainrow"><span class="lbl">Blocks</span><span class="chips">${chips(report.dirtySemanticNodes)}</span></div>
      <div class="chainrow"><span class="lbl">Deps</span><span class="chips">${chips(deps, 'dep')}</span></div>
      <div class="chainrow"><span class="lbl">Pages</span><span class="chips">${chips(report.dirtyPages.map((p) => 'page ' + p), 'page')}</span></div>
      <div class="chainrow"><span class="lbl">Patches</span><span class="chips">${chips(report.patches.map((p) => (p.type === 'replace-page' ? `replace p${p.page}` : `${p.type} ${p.from ?? ''}`)), 'page')}</span></div>
    </div>

    <div class="card">
      <h3>キャッシュ / 再利用</h3>
      <div class="kv">${cacheRows}</div>
    </div>

    <div class="card">
      <h3>フェーズ別時間</h3>
      <div class="bars">
        ${phases
          .map(
            ([n, us]) => `
          <div class="bar">
            <span class="n">${n}</span>
            <span class="track"><span class="fill" style="width:${Math.max(2, (us / maxUs) * 100)}%"></span></span>
            <span class="t">${fmtUs(us)}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>

    ${
      (s.macrosChanged?.length || s.labelsChanged?.length)
        ? `<div class="card"><h3>依存グラフ差分</h3>
           <div class="chainrow"><span class="lbl">macros</span><span class="chips">${chips((s.macrosChanged ?? []).map((m) => '\\' + m), 'dep')}</span></div>
           <div class="chainrow"><span class="lbl">labels</span><span class="chips">${chips(s.labelsChanged ?? [], 'dep')}</span></div></div>`
        : ''
    }

    ${
      s.diagnostics?.length
        ? `<div class="card"><h3>診断</h3>${s.diagnostics
            .slice(0, 6)
            .map((d) => `<div class="diag">${escapeHtml(d)}</div>`)
            .join('')}</div>`
        : ''
    }

    ${
      history.length
        ? `<div class="card"><h3>履歴</h3><div class="hist">${history
            .map(
              (h) =>
                `<div><b>#${h.rev}</b><span>${escapeHtml(shortEdit(h.edit))}</span><span>p[${h.pages.join(',')}]</span><span class="t">${fmtUs(h.us)}</span></div>`
            )
            .join('')}</div></div>`
        : ''
    }
  `;
}

function shortEdit(edit) {
  return edit.replace('main.tex:', '');
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}
function escapeHtml(s) {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

// ---------------------------------------------------------------- SSE

const sse = new EventSource('/events');
sse.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.kind === 'patches') {
      // async arrivals (TikZ exact renders, background chain discoveries)
      if (msg.rev > appliedRev) {
        appliedRev = msg.rev;
        for (const patch of msg.patches) {
          if (patch.type === 'replace-page') renderPage(patch.displayList, true);
          else if (patch.type === 'remove-pages') removePagesFrom(patch.from);
        }
        repositionBox();
      }
      return;
    }
    if (msg.kind === 'update' && msg.report.rev > appliedRev) {
      applyReport(msg.report);
      renderInspector(msg.report, null);
      fetch('/doc')
        .then((r) => r.json())
        .then((doc) => {
          if (doc.report.rev === appliedRev && editor.value !== doc.source && document.activeElement !== editor) {
            serverText = doc.source;
            editor.value = doc.source;
          }
        });
    } else if (msg.kind === 'reset') {
      if (document.activeElement !== editor) boot();
    }
  } catch {
    /* ignore malformed events */
  }
};

// collapsible inspector (preference persists)
function setInspector(hidden) {
  document.body.classList.toggle('no-inspector', hidden);
  localStorage.setItem('tdom-inspector', hidden ? 'hidden' : 'shown');
}
document.getElementById('insp-toggle').addEventListener('click', () => setInspector(true));
document.getElementById('insp-reopen').addEventListener('click', () => setInspector(false));
setInspector(localStorage.getItem('tdom-inspector') === 'hidden');

boot();
loadTemplateList();
