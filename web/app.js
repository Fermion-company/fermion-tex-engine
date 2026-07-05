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
const editorHighlightEl = document.getElementById('editor-highlight');
const pagesEl = document.getElementById('pages');
const statusEl = document.getElementById('status');
const inspectorEl = document.getElementById('inspector');
const menuToggleButton = document.getElementById('menu-toggle');
const layoutViewEl = document.getElementById('layout-view');
const templateSelectEl = document.getElementById('tpl-select');
const layoutSplitterEl = document.getElementById('workspace-preview-splitter');
const layoutEl = document.getElementById('layout');
const editorPaneEl = document.getElementById('editor-pane');
const workspacePaneEl = document.getElementById('workspace-pane');
const previewPaneEl = document.getElementById('preview-pane');
const outlineEl = document.getElementById('doc-outline');
const visualEditorEl = document.getElementById('visual-editor');
const wordEditorEl = document.getElementById('word-editor');
const wordEditorBodyEl = document.getElementById('word-editor-body');
const structureViewEl = document.getElementById('structure-view');
const refsViewEl = document.getElementById('refs-view');
const refLabelSelectEl = document.getElementById('ref-label-select');
const refLabelNameEl = document.getElementById('ref-label-name');
const refRenameButton = document.getElementById('ref-rename');
const refListCommandEl = document.getElementById('ref-list-command');
const refListTargetEl = document.getElementById('ref-list-target');
const refListInsertButton = document.getElementById('ref-list-insert');
const refCommandEl = document.getElementById('ref-command');
const refTargetEl = document.getElementById('ref-target');
const refInsertButton = document.getElementById('ref-insert');
const citeKeySelectEl = document.getElementById('cite-key-select');
const citeTargetEl = document.getElementById('cite-target');
const citeInsertButton = document.getElementById('cite-insert');
const bibKeyEl = document.getElementById('bib-key');
const bibTextEl = document.getElementById('bib-text');
const bibAddButton = document.getElementById('bib-add');
const bibUpdateButton = document.getElementById('bib-update');
const docSummaryEl = document.getElementById('doc-summary');
const regionTypeEl = document.getElementById('region-type');
const regionTargetEl = document.getElementById('region-target');
const regionTitleEl = document.getElementById('region-title');
const regionLabelEl = document.getElementById('region-label');
const regionBodyEl = document.getElementById('region-body');
const regionInsertButton = document.getElementById('region-insert');
const codeTitleEl = document.getElementById('code-title');
const codeTargetEl = document.getElementById('code-target');
const codeLinesEl = document.getElementById('code-lines');
const codeBodyEl = document.getElementById('code-body');
const codeInsertButton = document.getElementById('code-insert');
const codeFileInputEl = document.getElementById('code-file-input');
const codeFilePickButton = document.getElementById('code-file-pick');
const codePickedFileEl = document.getElementById('code-picked-file');
const codeFilePreviewMetaEl = document.getElementById('code-file-preview-meta');
const codeFilePreviewBodyEl = document.getElementById('code-file-preview-body');
const codeFileKindEl = document.getElementById('code-file-kind');
const codeFileTargetEl = document.getElementById('code-file-target');
const codeFileIntegrateButton = document.getElementById('code-file-integrate');
const codeSplitTitleEl = document.getElementById('code-split-title');
const codeSplitNameEl = document.getElementById('code-split-name');
const codeSplitCommandEl = document.getElementById('code-split-command');
const codeSplitTargetEl = document.getElementById('code-split-target');
const codeSplitBodyEl = document.getElementById('code-split-body');
const codeSplitCreateButton = document.getElementById('code-split-create');
const codeFileListEl = document.getElementById('code-file-list');
const imageFileEl = document.getElementById('image-file');
const imageTargetEl = document.getElementById('image-target');
const imageWidthEl = document.getElementById('image-width');
const imageCaptionEl = document.getElementById('image-caption');
const imageInsertButton = document.getElementById('image-insert');
const aiPromptEl = document.getElementById('ai-prompt');
const aiCommandEl = document.getElementById('ai-command');
const aiTargetEl = document.getElementById('ai-target');
const aiDraftButton = document.getElementById('ai-draft');
const aiInsertButton = document.getElementById('ai-insert');
const aiResultEl = document.getElementById('ai-result');
const aiDialogEl = document.getElementById('ai-dialog');
const aiPreviewStageEl = document.getElementById('ai-preview-stage');
const aiLaneInputs = [...document.querySelectorAll('input[name="ai-lane"]')];
const aiModeLabels = [...document.querySelectorAll('[data-ai-scope]')];
const tableRowsEl = document.getElementById('table-rows');
const tableColsEl = document.getElementById('table-cols');
const tableAlignEl = document.getElementById('table-align');
const tableStyleEl = document.getElementById('table-style');
const tableColspecEl = document.getElementById('table-colspec');
const tableHeaderEl = document.getElementById('table-header');
const tableLinesEl = document.getElementById('table-lines');
const tableResizeButton = document.getElementById('table-resize');
const tableAddRowButton = document.getElementById('table-add-row');
const tableAddColButton = document.getElementById('table-add-col');
const tableDelRowButton = document.getElementById('table-del-row');
const tableDelColButton = document.getElementById('table-del-col');
const tableGridEl = document.getElementById('table-grid');
const tableCaptionEl = document.getElementById('table-caption');
const tableTargetEl = document.getElementById('table-target');
const tableInsertButton = document.getElementById('table-insert');
const tablePasteEl = document.getElementById('table-paste');
const tableImportButton = document.getElementById('table-import');
const tableSelectionEl = document.getElementById('table-selection');
const tableRowspanEl = document.getElementById('table-rowspan');
const tableColspanEl = document.getElementById('table-colspan');
const tableMergeApplyButton = document.getElementById('table-merge-apply');
const tableMergeClearButton = document.getElementById('table-merge-clear');
const customDocClassEl = document.getElementById('custom-doc-class');
const customDocOptionsEl = document.getElementById('custom-doc-options');
const customPaperEl = document.getElementById('custom-paper');
const customMarginEl = document.getElementById('custom-margin');
const customTitleEl = document.getElementById('custom-title');
const customAuthorEl = document.getElementById('custom-author');
const customDateEl = document.getElementById('custom-date');
const customMaketitleEl = document.getElementById('custom-maketitle');
const customPackagesEl = document.getElementById('custom-packages');
const customApplyButton = document.getElementById('custom-apply');
const packagePresetButtons = [...document.querySelectorAll('[data-package-preset]')];
const templateNameEl = document.getElementById('template-name');
const templateDescEl = document.getElementById('template-desc');
const templateSaveButton = document.getElementById('template-save');
const drawSvgEl = document.getElementById('draw-svg');
const drawPaletteEl = document.getElementById('draw-palette');
const drawAddButton = document.getElementById('draw-add');
const drawUndoButton = document.getElementById('draw-undo');
const drawRedoButton = document.getElementById('draw-redo');
const drawDuplicateButton = document.getElementById('draw-duplicate');
const drawBackButton = document.getElementById('draw-back');
const drawFrontButton = document.getElementById('draw-front');
const drawDeleteButton = document.getElementById('draw-delete');
const drawSnapEl = document.getElementById('draw-snap');
const drawGridSizeEl = document.getElementById('draw-grid-size');
const drawItemsEl = document.getElementById('draw-items');
const drawPropsEl = document.getElementById('draw-props');
const drawInsertButton = document.getElementById('draw-insert');
const drawClearButton = document.getElementById('draw-clear');
const drawCaptionEl = document.getElementById('draw-caption');
const drawTargetEl = document.getElementById('draw-target');
const workspaceBlocks = new Map();
let referenceLabels = [];
let bibliographyItems = [];
let selectedWordBlockId = null;
let activeWordTextarea = null;
let customizeDirty = false;
let aiDraft = null;
let aiLastPrompt = '';
let uploadedTexFiles = [];
let selectedCodeFile = null;
let pendingCodeFile = null;
let tableData = [
  ['項目', '値', '備考'],
  ['Alpha', '1.0', ''],
  ['Beta', '2.0', ''],
  ['Gamma', '3.0', ''],
];
const tableMerges = new Map();
let splitRatio = 48;

function applyLayoutView(value = layoutViewEl?.value || 'both') {
  document.body.dataset.layoutView = value;
}

function applySplitRatio(value = splitRatio) {
  const workspace = Math.max(35, Math.min(70, Number(value) || splitRatio || 48));
  splitRatio = workspace;
  const { workspacePx, previewPx } = splitColumnWidths(workspace);
  document.documentElement.style.setProperty('--workspace-width', `${workspacePx}px`);
  document.documentElement.style.setProperty('--preview-width', `${previewPx}px`);
  layoutSplitterEl?.setAttribute('aria-valuenow', String(Math.round(workspace)));
}

function splitColumnWidths(workspaceRatio) {
  const layoutWidth = layoutEl?.getBoundingClientRect().width || window.innerWidth || 1;
  const menuVisible = editorPaneEl && getComputedStyle(editorPaneEl).display !== 'none';
  const menuWidth = menuVisible ? editorPaneEl.getBoundingClientRect().width : 0;
  const splitterVisible = layoutSplitterEl && getComputedStyle(layoutSplitterEl).display !== 'none';
  const splitterWidth = splitterVisible ? layoutSplitterEl.getBoundingClientRect().width || 8 : 0;
  const available = Math.max(1, layoutWidth - menuWidth - splitterWidth);
  const workspacePx = Math.round((available * workspaceRatio) / 100);
  return {
    workspacePx,
    previewPx: Math.max(1, Math.round(available - workspacePx)),
  };
}

function setMenuCollapsed(collapsed) {
  document.body.classList.toggle('menu-collapsed', collapsed);
  if (menuToggleButton) {
    menuToggleButton.textContent = '☰';
    menuToggleButton.title = collapsed ? 'メニューバーを開く' : 'メニューバーを閉じる';
    menuToggleButton.setAttribute('aria-label', menuToggleButton.title);
    menuToggleButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
  applySplitRatio();
}

function splitRatioFromPointer(clientX) {
  if (!workspacePaneEl || !previewPaneEl) return splitRatio;
  const workspaceRect = workspacePaneEl.getBoundingClientRect();
  const previewRect = previewPaneEl.getBoundingClientRect();
  const left = workspaceRect.left;
  const right = previewRect.right;
  const total = right - left;
  if (total <= 0) return splitRatio;
  return ((clientX - left) / total) * 100;
}

function beginLayoutResize(ev) {
  if (document.body.dataset.layoutView !== 'both') return;
  ev.preventDefault();
  layoutSplitterEl?.setPointerCapture?.(ev.pointerId);
  document.body.classList.add('is-resizing-layout');
  applySplitRatio(splitRatioFromPointer(ev.clientX));

  function onPointerMove(moveEv) {
    applySplitRatio(splitRatioFromPointer(moveEv.clientX));
  }

  function finish() {
    document.body.classList.remove('is-resizing-layout');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

function nudgeLayoutSplit(delta) {
  applySplitRatio(splitRatio + delta);
}

function highlightTexSource(source) {
  if (!editorHighlightEl) return;
  const html = escapeHtml(source || '')
    .replace(/(%[^\n]*)/g, '<span class="tok-comment">$1</span>')
    .replace(/(\\(?:[A-Za-z@]+|.))/g, '<span class="tok-command">$1</span>')
    .replace(/(\{[^{}\n]*\})/g, '<span class="tok-brace">$1</span>')
    .replace(/(\$[^$\n]*\$)/g, '<span class="tok-math">$1</span>');
  editorHighlightEl.innerHTML = html + (source.endsWith('\n') ? '\n' : '');
}

function syncEditorHighlight() {
  if (!editor || !editorHighlightEl) return;
  highlightTexSource(editor.value);
  editorHighlightEl.scrollTop = editor.scrollTop;
  editorHighlightEl.scrollLeft = editor.scrollLeft;
}

const topbarSelectMenus = new Map();

function enhanceTopbarSelect(select) {
  if (!select || topbarSelectMenus.has(select)) return;
  select.dataset.topbarEnhanced = 'true';
  select.tabIndex = -1;

  const wrap = document.createElement('div');
  wrap.className = 'topbar-select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'topbar-select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.title = select.title || '';
  const menu = document.createElement('div');
  menu.className = 'topbar-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.appendChild(button);
  wrap.appendChild(menu);
  select.after(wrap);

  const state = { wrap, button, menu };
  topbarSelectMenus.set(select, state);

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const selected = select.selectedOptions?.[0] ?? select.options[select.selectedIndex] ?? select.options[0];
    button.textContent = selected?.textContent || select.title || '選択';
    menu.textContent = '';
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'topbar-select-item';
      item.textContent = option.textContent;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      item.disabled = option.disabled;
      item.addEventListener('click', () => {
        if (option.value === select.value && select.id !== 'tpl-select') {
          close();
          return;
        }
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
        close();
      });
      menu.appendChild(item);
    }
  }

  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    for (const other of topbarSelectMenus.values()) {
      if (other !== state) {
        other.menu.hidden = true;
        other.button.setAttribute('aria-expanded', 'false');
      }
    }
    const nextHidden = !menu.hidden;
    menu.hidden = nextHidden;
    button.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
  });
  select.addEventListener('change', render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true });
  render();
}

document.addEventListener('click', () => {
  for (const state of topbarSelectMenus.values()) {
    state.menu.hidden = true;
    state.button.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const state of topbarSelectMenus.values()) {
    state.menu.hidden = true;
    state.button.setAttribute('aria-expanded', 'false');
  }
});
let selectedTableCell = { row: 0, col: 0 };
let drawMode = '2d';
let drawTool = 'line';
let drawItems = [];
let drawNextId = 1;
let selectedDrawId = null;
let drawDragState = null;
let suppressNextDrawClick = false;
const drawUndoStack = [];
const drawRedoStack = [];
const DRAW_HISTORY_LIMIT = 80;
const PACKAGE_PRESETS = {
  math: ['amsmath', 'amssymb', 'mathtools'],
  figures: ['graphicx', 'float'],
  tables: ['tabularray', 'booktabs'],
  refs: ['hyperref[colorlinks=true]', 'cleveref'],
  drawing: ['tikz', 'pgfplots'],
  design: ['xcolor', 'tcolorbox'],
  code: ['kkluaverb'],
};

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
  loadUploadedTexFiles();
  statusEl.textContent = '';
  renderInspector(doc.report, null);
}

function adoptDoc(doc) {
  geometry = doc.geometry;
  backend = doc.backend ?? 'internal';
  injectFonts(doc.fonts);
  serverText = doc.source;
  editor.value = doc.source;
  syncEditorHighlight();
  pagesEl.textContent = '';
  pageDivs.clear();
  for (const dl of doc.pages) renderPage(dl, false);
  appliedRev = doc.report.rev;
  refreshWorkspace();
}

async function refreshWorkspace() {
  if (!outlineEl || !visualEditorEl || !structureViewEl || !refsViewEl) return;
  try {
    const [doc, dom] = await Promise.all([
      fetch('/doc').then((r) => r.json()),
      fetch('/dom').then((r) => r.json()),
    ]);
    renderWorkspace(doc, dom);
  } catch (err) {
    console.warn('workspace refresh failed:', err);
  }
}

function renderWorkspace(doc, dom) {
  const blocks = (dom.blocks ?? []).filter((block) => block.span);
  workspaceBlocks.clear();
  for (const block of blocks) workspaceBlocks.set(block.id, block);
  const headings = blocks.filter((block) => block.type === 'heading');
  const labels = collectLabels(blocks);
  const refs = collectRefs(blocks);
  const refObjects = collectReferenceObjects(blocks, doc.source);
  const bibItems = collectBibliographyItems(doc.source);
  referenceLabels = labels;
  bibliographyItems = bibItems;
  docSummaryEl.textContent = `${blocks.length} blocks / ${headings.length} sections / ${labels.length} labels`;
  renderOutline(headings, doc.source);
  renderVisualBlocks(blocks, doc.source);
  if (selectedWordBlockId) renderWordEditor(selectedWordBlockId, doc.source);
  renderStructure(headings, doc.source);
  renderRefs(labels, refs, refObjects, bibItems);
  renderRefControls(labels, blocks, doc.source, bibItems);
  renderInsertTargets(blocks, doc.source);
  renderCustomizeSettings(doc.source);
  renderCodeFileList(doc.source);
  highlightSelectedPreviewBlock();
}

function renderOutline(headings, source) {
  outlineEl.textContent = '';
  if (!headings.length) {
    outlineEl.innerHTML = '<div class="empty-state">見出しがありません</div>';
    return;
  }
  for (const block of headings) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.dataset.src = block.id;
    button.innerHTML = `
      <span class="outline-title">${escapeHtml(displayTitleForBlock(block, source))}</span>
      <span class="outline-meta">page ${(block.pages ?? []).join(', ') || '—'}</span>
    `;
    button.addEventListener('click', () => focusPreviewBlock(block.id));
    outlineEl.appendChild(button);
  }
}

function renderVisualBlocks(blocks, source) {
  visualEditorEl.textContent = '';
  const editable = blocks.filter((block) => block.index < 16 || blockTypeLabel(block, source) !== '本文');
  for (const block of editable) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doc-block';
    button.classList.toggle('is-selected', block.id === selectedWordBlockId);
    button.dataset.src = block.id;
    const title = displayTitleForBlock(block, source);
    const body = displayBodyForBlock(block, source);
    const labels = (block.labels ?? []).map((label) => `<span class="mini-chip">${escapeHtml(label)}</span>`).join('');
    button.innerHTML = `
      <span class="doc-block-head">
        <span class="doc-block-title">${escapeHtml(title)}</span>
        <span class="doc-block-page">page ${(block.pages ?? []).join(', ') || '—'}</span>
      </span>
      <span class="doc-block-type">${escapeHtml(blockTypeLabel(block, source))}</span>
      ${body ? `<span class="doc-block-body">${escapeHtml(body)}</span>` : ''}
      ${labels ? `<span class="doc-block-labels">${labels}</span>` : ''}
    `;
    button.addEventListener('click', () => selectWordBlock(block.id, source));
    visualEditorEl.appendChild(button);
  }
  if (!visualEditorEl.childElementCount) {
    visualEditorEl.innerHTML = '<div class="empty-state">編集できるブロックがありません</div>';
  }
}

function renderStructure(headings, source) {
  structureViewEl.textContent = '';
  for (const block of headings) {
    const row = document.createElement('div');
    row.className = 'structure-row';
    row.dataset.src = block.id;
    const level = headingLevelFromSource(blockSource(block, source));
    row.innerHTML = `
      <button class="structure-main" type="button" data-structure-focus="${escapeHtml(block.id)}">
        <span class="structure-title" style="padding-left:${Math.max(0, level - 1) * 14}px">${escapeHtml(displayTitleForBlock(block, source))}</span>
        <span class="structure-page">page ${(block.pages ?? []).join(', ') || '—'}</span>
      </button>
      <span class="structure-actions">
        <button type="button" data-structure-move="up" data-src="${escapeHtml(block.id)}">上へ</button>
        <button type="button" data-structure-move="down" data-src="${escapeHtml(block.id)}">下へ</button>
      </span>
    `;
    structureViewEl.appendChild(row);
  }
  if (!structureViewEl.childElementCount) {
    structureViewEl.innerHTML = '<div class="empty-state">構成要素がありません</div>';
  }
}

structureViewEl?.addEventListener('click', (ev) => {
  const move = ev.target.closest('[data-structure-move]');
  if (move) {
    moveHeadingSection(move.dataset.src, move.dataset.structureMove);
    return;
  }
  const focus = ev.target.closest('[data-structure-focus]');
  if (focus) focusPreviewBlock(focus.dataset.structureFocus);
});

function headingLevelFromSource(raw) {
  const match = raw.match(/\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\b/);
  const order = ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
  return match ? Math.max(1, order.indexOf(match[1]) + 1) : 2;
}

function headingSections(source) {
  const headings = [...workspaceBlocks.values()]
    .filter((block) => block.type === 'heading' && block.span)
    .map((block) => ({
      id: block.id,
      start: block.span.start,
      commandStart: blockSource(block, source),
      level: headingLevelFromSource(blockSource(block, source)),
    }))
    .sort((a, b) => a.start - b.start);
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((entry) => entry.level <= heading.level);
    return {
      ...heading,
      end: next ? next.start : source.replace(/\s*\\end\{document\}\s*$/, '').length,
    };
  });
}

function moveHeadingSection(src, direction) {
  const source = editor.value;
  const sections = headingSections(source);
  const index = sections.findIndex((section) => section.id === src);
  if (index < 0) return;
  const current = sections[index];
  const siblingIndexes = sections
    .map((section, i) => ({ section, i }))
    .filter(({ section }) => section.level === current.level);
  const siblingPos = siblingIndexes.findIndex(({ i }) => i === index);
  const target = direction === 'up' ? siblingIndexes[siblingPos - 1] : siblingIndexes[siblingPos + 1];
  if (!target) return;
  const other = target.section;
  let next;
  if (direction === 'up') {
    next =
      source.slice(0, other.start) +
      source.slice(current.start, current.end).trimEnd() + '\n\n' +
      source.slice(other.start, current.start).trimEnd() + '\n' +
      source.slice(current.end);
  } else {
    next =
      source.slice(0, current.start) +
      source.slice(current.end, other.end).trimEnd() + '\n\n' +
      source.slice(current.start, current.end).trimEnd() + '\n' +
      source.slice(other.end);
  }
  editor.value = next;
  selectedWordBlockId = null;
  scheduleSync();
  statusEl.textContent = '構成を並べ替えました';
}

function renderRefs(labels, refs, objects = [], bibItems = []) {
  refsViewEl.textContent = '';
  for (const item of objects) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ref-row';
    row.dataset.src = item.src;
    row.innerHTML = `
      <span>
        <span class="ref-name">${escapeHtml(item.title)}</span>
        <span class="ref-detail">${escapeHtml(item.detail)}</span>
      </span>
      <span class="ref-kind">${escapeHtml(item.kind)}</span>
    `;
    row.addEventListener('click', () => focusPreviewBlock(item.src));
    refsViewEl.appendChild(row);
  }
  for (const item of bibItems) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ref-row';
    row.dataset.src = item.src || '';
    row.innerHTML = `
      <span>
        <span class="ref-name">${escapeHtml(item.key)}</span>
        <span class="ref-detail">${escapeHtml(item.text)}</span>
      </span>
      <span class="ref-kind">文献</span>
    `;
    row.addEventListener('click', () => item.src && focusPreviewBlock(item.src));
    refsViewEl.appendChild(row);
  }
  for (const item of labels) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ref-row';
    row.dataset.src = item.src;
    row.innerHTML = `
      <span>
        <span class="ref-name">${escapeHtml(item.name)}</span>
        <span class="ref-detail">${escapeHtml(item.owner)}</span>
      </span>
      <span class="ref-kind">label</span>
    `;
    row.addEventListener('click', () => focusPreviewBlock(item.src));
    refsViewEl.appendChild(row);
  }
  for (const item of refs) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ref-row';
    row.dataset.src = item.src;
    row.innerHTML = `
      <span>
        <span class="ref-name">${escapeHtml(item.name)}</span>
        <span class="ref-detail">${escapeHtml(item.owner)}</span>
      </span>
      <span class="ref-kind">ref</span>
    `;
    row.addEventListener('click', () => focusPreviewBlock(item.src));
    refsViewEl.appendChild(row);
  }
  if (!refsViewEl.childElementCount) {
    refsViewEl.innerHTML = '<div class="empty-state">参照情報がありません</div>';
  }
}

function renderRefControls(labels, blocks, source, bibItems = []) {
  if (refLabelSelectEl) {
    const previous = refLabelSelectEl.value;
    refLabelSelectEl.textContent = '';
    for (const item of labels) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = `${item.name} / ${item.owner}`;
      refLabelSelectEl.appendChild(option);
    }
    refLabelSelectEl.value = labels.some((item) => item.name === previous) ? previous : labels[0]?.name ?? '';
    if (refLabelNameEl && !refLabelNameEl.value) refLabelNameEl.value = refLabelSelectEl.value;
  }
  const targets = [
    { value: 'end', label: '文末' },
    ...blocks
      .filter((block) => block.span && blockTypeLabel(block, source) !== '目次')
      .map((block) => ({ value: block.id, label: `${displayTitleForBlock(block, source)} の後` })),
  ];
  if (refTargetEl) {
    const previous = refTargetEl.value || 'end';
    refTargetEl.textContent = '';
    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.value;
      option.textContent = target.label;
      refTargetEl.appendChild(option);
    }
    refTargetEl.value = targets.some((target) => target.value === previous) ? previous : 'end';
  }
  if (citeTargetEl) {
    const previous = citeTargetEl.value || 'end';
    citeTargetEl.textContent = '';
    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.value;
      option.textContent = target.label;
      citeTargetEl.appendChild(option);
    }
    citeTargetEl.value = targets.some((target) => target.value === previous) ? previous : 'end';
  }
  if (citeKeySelectEl) {
    const previous = citeKeySelectEl.value;
    citeKeySelectEl.textContent = '';
    for (const item of bibItems) {
      const option = document.createElement('option');
      option.value = item.key;
      option.textContent = `${item.key} / ${item.text.slice(0, 60)}`;
      citeKeySelectEl.appendChild(option);
    }
    citeKeySelectEl.value = bibItems.some((item) => item.key === previous) ? previous : bibItems[0]?.key ?? '';
    if (![bibKeyEl, bibTextEl].includes(document.activeElement)) populateBibliographyFields(citeKeySelectEl.value);
  }
  if (refListTargetEl) {
    const previous = refListTargetEl.value || 'end';
    refListTargetEl.textContent = '';
    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.value;
      option.textContent = target.label;
      refListTargetEl.appendChild(option);
    }
    refListTargetEl.value = targets.some((target) => target.value === previous) ? previous : 'end';
  }
}

function renderInsertTargets(blocks, source) {
  const targets = [
    { value: 'end', label: '文末' },
    ...blocks
      .filter((block) => block.span && (block.type === 'heading' || parseMathLens(blockSource(block, source)) || /\\begin\{figure|table\}/.test(blockSource(block, source))))
      .map((block) => ({
        value: block.id,
        label: `${displayTitleForBlock(block, source)} の後`,
      })),
  ];
  for (const select of [regionTargetEl, codeTargetEl, imageTargetEl, tableTargetEl, drawTargetEl, aiTargetEl, codeFileTargetEl, codeSplitTargetEl]) {
    if (!select) continue;
    const previous = select.value || 'end';
    select.textContent = '';
    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.value;
      option.textContent = target.label;
      select.appendChild(option);
    }
    select.value = targets.some((target) => target.value === previous) ? previous : 'end';
  }
}

function collectLabels(blocks) {
  const out = [];
  for (const block of blocks) {
    for (const name of block.labels ?? []) {
      out.push({ name, src: block.id, owner: `${blockTypeLabel(block)} / page ${(block.pages ?? []).join(', ') || '—'}` });
    }
  }
  return out;
}

function collectExternalFiles(source) {
  const out = [];
  const push = (kind, pathText, command) => {
    const pathValue = String(pathText || '').trim();
    if (!pathValue) return;
    out.push({ kind, path: pathValue, command });
  };
  for (const match of source.matchAll(/\\(?:input|include)\{([^{}]+)\}/g)) {
    push(match[0].startsWith('\\include') ? '分割TeX' : '入力TeX', match[1], match[0].split('{')[0]);
  }
  for (const match of source.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^{}]+)\}/g)) {
    for (const name of match[1].split(',').map((part) => part.trim()).filter(Boolean)) {
      push(name.includes('/') || name.includes('.') ? '.sty' : 'パッケージ', name, '\\usepackage');
    }
  }
  for (const match of source.matchAll(/\\(?:bibliography|addbibresource)\{([^{}]+)\}/g)) {
    push('文献DB', match[1], match[0].split('{')[0]);
  }
  return out;
}

function codeFileIcon(kind, pathText = '') {
  const ext = String(pathText).split('.').pop()?.toLowerCase();
  if (kind === '文献DB' || ext === 'bib') return 'BIB';
  if (kind === '.sty' || ext === 'sty') return 'STY';
  if (ext === 'cls') return 'CLS';
  return 'TEX';
}

function renderCodeFileTree(items) {
  const groups = new Map();
  for (const item of items) {
    const parts = item.path.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : 'document';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }
  return [...groups.entries()]
    .map(([folder, files]) => `
      <div class="code-folder">
        <div class="code-folder-name">${escapeHtml(folder)}</div>
        ${files
          .map((item) => `
            <button class="code-file-item ${item.uploaded ? 'is-uploaded' : ''} ${selectedCodeFile?.path === item.path ? 'is-selected' : ''}" type="button" data-code-file-path="${escapeHtml(item.path)}" data-code-file-kind="${escapeHtml(item.fileKind || '')}" data-code-file-uploaded="${item.uploaded ? 'true' : 'false'}">
              <span class="code-file-icon">${escapeHtml(codeFileIcon(item.kind, item.path))}</span>
              <span class="code-file-path">${escapeHtml(item.path.split('/').pop() || item.path)}</span>
              <span class="code-file-command">${escapeHtml(item.command)}</span>
            </button>
          `)
          .join('')}
      </div>
    `)
    .join('');
}

function renderCodeFileList(source) {
  if (!codeFileListEl) return;
  const current = collectExternalFiles(source);
  const uploaded = uploadedTexFiles.filter((file) => !current.some((item) => item.path === file.texPath || item.path === file.packageName));
  if (!current.length && !uploaded.length) {
    codeFileListEl.innerHTML = '<div class="empty-state">＋ ファイル から .tex/.sty/.cls/.bib を追加できます</div>';
    return;
  }
  const items = [
    ...current.map((item) => ({ ...item, uploaded: false, fileKind: texFileKind(item.path, 'auto') })),
    ...uploaded.map((file) => ({ kind: '保存済み', path: file.texPath, command: '未参照', uploaded: true, fileKind: texFileKind(file.texPath, 'auto') })),
  ];
  codeFileListEl.innerHTML = renderCodeFileTree(items);
}

async function loadUploadedTexFiles() {
  try {
    uploadedTexFiles = await fetch('/texfiles').then((r) => r.json());
    renderCodeFileList(editor.value);
  } catch (err) {
    console.warn('tex file list failed:', err);
  }
}

function collectRefs(blocks) {
  const out = [];
  for (const block of blocks) {
    for (const name of block.refs ?? []) {
      out.push({ name, src: block.id, owner: `${blockTypeLabel(block)} / page ${(block.pages ?? []).join(', ') || '—'}` });
    }
  }
  return out;
}

function collectReferenceObjects(blocks, source) {
  const out = [];
  for (const block of blocks) {
    if (!block.span) continue;
    const raw = blockSource(block, source);
    if (/\\tableofcontents\b/.test(raw)) {
      out.push({ kind: '目次', title: '目次', detail: `page ${(block.pages ?? []).join(', ') || '—'}`, src: block.id });
      continue;
    }
    if (/\\listoffigures\b/.test(raw)) {
      out.push({ kind: '図一覧', title: '図一覧', detail: `page ${(block.pages ?? []).join(', ') || '—'}`, src: block.id });
      continue;
    }
    if (/\\listoftables\b/.test(raw)) {
      out.push({ kind: '表一覧', title: '表一覧', detail: `page ${(block.pages ?? []).join(', ') || '—'}`, src: block.id });
      continue;
    }
    const caption = raw.match(/\\caption\{([^{}]*)\}/)?.[1]?.trim();
    if (/\\begin\{figure\}/.test(raw)) {
      out.push({ kind: '図', title: caption || displayTitleForBlock(block, source), detail: objectDetail(block), src: block.id });
    } else if (/\\begin\{table\}/.test(raw)) {
      out.push({ kind: '表', title: caption || displayTitleForBlock(block, source), detail: objectDetail(block), src: block.id });
    } else if (block.type === 'heading') {
      out.push({ kind: '章節', title: displayTitleForBlock(block, source), detail: objectDetail(block), src: block.id });
    }
  }
  return out;
}

function objectDetail(block) {
  const labels = (block.labels ?? []).length ? ` / label: ${(block.labels ?? []).join(', ')}` : '';
  return `page ${(block.pages ?? []).join(', ') || '—'}${labels}`;
}

function collectBibliographyItems(source) {
  const items = [];
  const blockByCitation = new Map();
  for (const block of workspaceBlocks.values()) {
    for (const label of block.labels ?? []) {
      if (label.startsWith('cite:')) blockByCitation.set(label.slice(5), block.id);
    }
  }
  const env = source.match(/\\begin\{thebibliography\}\{[^{}]*\}([\s\S]*?)\\end\{thebibliography\}/);
  if (!env) return items;
  const body = env[1];
  const re = /\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}([\s\S]*?)(?=\\bibitem(?:\[[^\]]*\])?\{|$)/g;
  let match;
  while ((match = re.exec(body))) {
    const key = match[1].trim();
    const text = stripTexForDisplay(match[2]).replace(/\s+/g, ' ').trim();
    items.push({ key, text: text || key, src: blockByCitation.get(key) || '' });
  }
  return items;
}

function blockSource(block, source) {
  if (!block.span) return '';
  return source.slice(block.span.start, block.span.end);
}

function displayTitleForBlock(block, source) {
  const raw = blockSource(block, source);
  if (/\\tableofcontents\b/.test(raw)) return '目次';
  if (/\\listoffigures\b/.test(raw)) return '図一覧';
  if (/\\listoftables\b/.test(raw)) return '表一覧';
  const lens = parseCommandLens(raw);
  if (lens?.fields?.length) return lens.fields[0].value.trim() || blockTypeLabel(block, source);
  const math = parseMathLens(raw);
  if (math) return math.label ? `数式 ${math.label}` : '数式';
  const code = parseCodeBlockLens(raw);
  if (code) return code.title;
  const caption = raw.match(/\\caption\{([^{}]*)\}/)?.[1];
  if (caption) return caption.trim();
  return blockTypeLabel(block, source);
}

function displayBodyForBlock(block, source) {
  const raw = blockSource(block, source);
  if (/\\tableofcontents\b/.test(raw)) return '';
  if (/\\listoffigures\b|\\listoftables\b/.test(raw)) return '';
  const code = parseCodeBlockLens(raw);
  if (code) return `${code.lines ? '行番号つきコード' : 'コード'}: ${code.body.split(/\r?\n/).length} lines`;
  const simpleTable = parseSimpleTableLens(raw);
  if (simpleTable) return tableRowsToText(simpleTable.rows).replace(/\n/g, ' / ').slice(0, 180);
  if (/\\begin\{figure\}/.test(raw)) {
    const draws = (raw.match(/\\draw/g) ?? []).length;
    const nodes = (raw.match(/\\node/g) ?? []).length;
    const plots = (raw.match(/\\(?:add)?plot/g) ?? []).length;
    const parts = [];
    if (draws) parts.push(`線・図形 ${draws}`);
    if (nodes) parts.push(`ラベル ${nodes}`);
    if (plots) parts.push(`グラフ ${plots}`);
    return parts.length ? `TikZ図: ${parts.join(' / ')}` : 'TikZ図';
  }
  const list = parseListLens(raw);
  if (list) return list.items.map((item) => `- ${item.text}`).join(' ').slice(0, 180);
  const alignment = parseAlignmentLens(raw);
  if (alignment) return stripTexForDisplay(alignment.body).slice(0, 180);
  const math = parseMathLens(raw);
  if (math) return math.math.replace(/\s+/g, ' ').slice(0, 120);
  return stripTexForDisplay(raw).slice(0, 180);
}

function blockTypeLabel(block, source = '') {
  const raw = source ? blockSource(block, source) : '';
  if (/\\tableofcontents\b/.test(raw)) return '目次';
  if (/\\listoffigures\b/.test(raw)) return '図一覧';
  if (/\\listoftables\b/.test(raw)) return '表一覧';
  if (parseCodeBlockLens(raw)) return 'コード';
  if (block.type === 'heading') return '見出し';
  if (parseMathLens(raw)) return '数式';
  if (parseSimpleTableLens(raw)) return '表';
  const list = parseListLens(raw);
  if (list) return listEnvironmentLabel(list.env);
  const alignment = parseAlignmentLens(raw);
  if (alignment) return alignmentEnvironmentLabel(alignment.env);
  if (/\\begin\{figure\}/.test(raw)) return '図';
  if (/\\begin\{table\}/.test(raw)) return '表';
  if (block.type === 'graphics') return 'TeXオブジェクト';
  return '本文';
}

function stripTexForDisplay(source) {
  return source
    .replace(/\\tableofcontents\b/g, '目次')
    .replace(/\\listoffigures\b/g, '図一覧')
    .replace(/\\listoftables\b/g, '表一覧')
    .replace(/\\LaTeX\{\}/g, 'LaTeX')
    .replace(/\\LuaLaTeX\{\}/g, 'LuaLaTeX')
    .replace(/\\label\{[^{}]*\}/g, '')
    .replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1')
    .replace(/\\[A-Za-z]+\*?\b/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function selectWordBlock(src, source = editor.value) {
  selectedWordBlockId = src;
  renderWordEditor(src, source);
  visualEditorEl?.querySelectorAll('.doc-block').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.src === src);
  });
  highlightSelectedPreviewBlock(src, { scroll: true });
  const el = document.querySelector(`[data-src="${src}"]`);
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function renderWordEditor(src, source = editor.value) {
  if (!wordEditorBodyEl) return;
  const block = workspaceBlocks.get(src);
  if (!block?.span) {
    wordEditorBodyEl.innerHTML = '<div class="empty-state">このブロックは編集できません</div>';
    return;
  }
  const raw = blockSource(block, source);
  const model = wordModelFromSource(raw, block);
  if (!model) {
    wordEditorBodyEl.innerHTML = `
      <div class="empty-state">このブロックは専用UIではまだ編集できません。プレビュー上の編集ボックスを使えます。</div>
      <button class="primary-action" type="button" data-word-preview="${escapeHtml(src)}">プレビューで編集</button>
    `;
    return;
  }
  wordEditorBodyEl.innerHTML = '';
  const form = document.createElement('div');
  form.className = 'word-form';
  form.dataset.src = src;
  form.dataset.modelKind = model.kind;

  if (!['paragraph', 'simpleTable'].includes(model.kind)) {
    form.appendChild(wordInputRow('タイトル', 'title', model.title ?? ''));
  }
  if (model.label !== null) {
    form.appendChild(wordInputRow('ラベル', 'label', model.label ?? ''));
  }
  const bodyLabel = document.createElement('label');
  bodyLabel.className = 'word-field word-field-wide';
  const label = document.createElement('span');
  label.textContent = model.bodyLabel || '本文';
  const textarea = document.createElement('textarea');
  textarea.dataset.wordField = 'body';
  textarea.value = model.body ?? '';
  textarea.readOnly = !!model.readonlyBody;
  textarea.classList.toggle('is-readonly', !!model.readonlyBody);
  textarea.spellcheck = !['math', 'code', 'simpleTable'].includes(model.kind);
  textarea.addEventListener('focus', () => {
    if (!model.readonlyBody) activeWordTextarea = textarea;
  });
  textarea.addEventListener('input', () => autosizeWordTextarea(textarea));
  bodyLabel.appendChild(label);
  bodyLabel.appendChild(textarea);
  form.appendChild(bodyLabel);

  const actions = document.createElement('div');
  actions.className = 'word-actions';
  actions.innerHTML = `
    <button class="primary-action" type="button" data-word-save>反映</button>
    <button type="button" data-word-preview="${escapeHtml(src)}">プレビューで編集</button>
  `;
  form.appendChild(actions);
  wordEditorBodyEl.appendChild(form);
  activeWordTextarea = textarea;
  autosizeWordTextarea(textarea);
}

function wordInputRow(labelText, field, value) {
  const row = document.createElement('label');
  row.className = 'word-field';
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.wordField = field;
  input.value = value;
  row.appendChild(label);
  row.appendChild(input);
  return row;
}

function wordModelFromSource(raw, block) {
  const commandLens = parseCommandLens(raw);
  if (commandLens?.fields?.length && /^\\(?:section|subsection|subsubsection|paragraph|subparagraph)\*?/.test(raw.trim())) {
    return {
      kind: 'heading',
      command: commandLens.fields[0].command,
      title: commandLens.fields[0].value,
      label: raw.match(/\\label\{([^{}]*)\}/)?.[1] ?? '',
      body: '',
      bodyLabel: 'メモ',
      raw,
    };
  }
  const math = parseMathLens(raw);
  if (math) {
    return {
      kind: 'math',
      label: math.label ?? '',
      body: mathBodyToTextArea(math.math),
      bodyLabel: '数式',
      lens: math,
      raw,
    };
  }
  const code = parseCodeBlockLens(raw);
  if (code) {
    return {
      kind: 'code',
      title: code.title,
      label: null,
      body: code.body,
      bodyLabel: code.lines ? 'コード（行番号あり）' : 'コード',
      lens: code,
      raw,
    };
  }
  const theorem = parseTheoremLikeLens(raw);
  if (theorem) {
    return {
      kind: 'theoremLike',
      env: theorem.env,
      title: theorem.title,
      label: theorem.label ?? '',
      body: theorem.body,
      bodyLabel: theorem.env === 'proof' ? '証明' : theoremEnvironmentLabel(theorem.env),
      raw,
    };
  }
  const floatMatch = raw.match(/\\begin\{(figure|table)\}/);
  if (floatMatch) {
    const label = commandArgumentValue(raw, 'label') ?? '';
    const caption = commandArgumentValue(raw, 'caption') ?? '';
    const kindLabel = floatMatch[1] === 'figure' ? '図' : '表';
    return {
      kind: 'float',
      floatEnv: floatMatch[1],
      title: stripTexForDisplay(caption) || kindLabel,
      label,
      body: displayBodyForBlock(block, editor.value) || `${kindLabel}の内容は作成ツールまたはプレビューで編集できます`,
      bodyLabel: `${kindLabel}の内容`,
      readonlyBody: true,
      raw,
    };
  }
  const simpleTable = parseSimpleTableLens(raw);
  if (simpleTable) {
    return {
      kind: 'simpleTable',
      title: '表',
      label: null,
      body: tableRowsToText(simpleTable.rows),
      bodyLabel: '表データ（タブ区切り）',
      lens: simpleTable,
      raw,
    };
  }
  if (/\\begin\{quote\}/.test(raw)) {
    return {
      kind: 'quote',
      label: null,
      body: raw.replace(/^\s*\\begin\{quote\}\s*/, '').replace(/\s*\\end\{quote\}\s*$/, ''),
      bodyLabel: '引用',
      raw,
    };
  }
  const list = parseListLens(raw);
  if (list) {
    return {
      kind: 'list',
      env: list.env,
      title: listEnvironmentLabel(list.env),
      label: null,
      body: listItemsToBody(list.items, list.env),
      bodyLabel: list.env === 'description' ? '項目（項目名: 内容）' : '項目（1行1項目）',
      raw,
    };
  }
  const alignment = parseAlignmentLens(raw);
  if (alignment) {
    return {
      kind: 'alignment',
      env: alignment.env,
      title: alignmentEnvironmentLabel(alignment.env),
      label: null,
      body: stripEditableParagraph(alignment.body),
      bodyLabel: '本文',
      raw,
    };
  }
  if (blockTypeLabel(block, editor.value) === '本文') {
    return { kind: 'paragraph', label: null, body: stripEditableParagraph(raw), bodyLabel: '本文', raw };
  }
  return null;
}

function stripEditableParagraph(raw) {
  return raw.trim();
}

function mathBodyToTextArea(math) {
  return splitMathRows(math).join('\n');
}

function parseCodeBlockLens(raw) {
  const match = raw.match(/^\s*(?:\\paragraph\{([^{}]*)\}\s*)?(\\KKcodeS\+?)\s*([\s\S]*?)\s*\\KKcodeE\s*$/);
  if (!match) return null;
  return {
    title: match[1] ? stripTexForDisplay(match[1]) || match[1] : 'Source code',
    startCommand: match[2],
    lines: match[2].endsWith('+'),
    body: normalizeCodeBlockBody(match[3]),
  };
}

function normalizeCodeBlockBody(body) {
  return String(body).replace(/^\r?\n/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

function parseListLens(raw) {
  const match = raw.match(/^(\s*)\\begin\{(itemize|enumerate|description)\}\s*([\s\S]*?)\s*\\end\{\2\}\s*$/);
  if (!match) return null;
  const body = match[3].trim();
  const itemRe = /\\item(?:\[([^\]]*)\])?\s*([\s\S]*?)(?=\\item(?:\[[^\]]*\])?\s*|$)/g;
  const items = [];
  let itemMatch;
  while ((itemMatch = itemRe.exec(body))) {
    items.push({
      marker: itemMatch[1]?.trim() ?? '',
      text: stripEditableParagraph(itemMatch[2] ?? ''),
    });
  }
  return {
    env: match[2],
    items: items.length ? items : [{ marker: '', text: stripEditableParagraph(body) }],
  };
}

function listItemsToBody(items, env = 'itemize') {
  return items
    .map((item) => {
      const marker = stripTexForDisplay(item.marker) || item.marker;
      const text = stripTexForDisplay(item.text) || item.text;
      if (env === 'description') return `${marker ? `${marker}: ` : ''}${text}`.trim();
      return `${marker ? `[${marker}] ` : ''}${text}`.trim();
    })
    .filter(Boolean)
    .join('\n');
}

function listEnvironmentLabel(env) {
  return {
    itemize: '箇条書き',
    enumerate: '番号付きリスト',
    description: '説明リスト',
  }[env] || env;
}

function parseAlignmentLens(raw) {
  const match = raw.match(/^(\s*)\\begin\{(center|flushleft|flushright)\}\s*([\s\S]*?)\s*\\end\{\2\}\s*$/);
  if (!match) return null;
  const body = match[3].trim();
  if (/\\begin\{/.test(body) || /\\end\{/.test(body)) return null;
  return { env: match[2], body };
}

function alignmentEnvironmentLabel(env) {
  return {
    center: '中央揃え',
    flushleft: '左揃え',
    flushright: '右揃え',
  }[env] || env;
}

function parseSimpleTableLens(raw) {
  const source = raw.trim();
  const centerMatch = source.match(/^\\begin\{center\}\s*([\s\S]*?)\s*\\end\{center\}$/);
  const tableSource = centerMatch ? centerMatch[1].trim() : source;
  const match = tableSource.match(/^\\begin\{(tabular|tblr)\}\{([^{}]*)\}\s*([\s\S]*?)\s*\\end\{\1\}$/);
  if (!match) return null;
  const body = match[3].trim();
  if (/\\(?:multicolumn|multirow|SetCell)\b/.test(body)) return null;
  const rules = {
    top: /\\toprule\b/.test(body),
    mid: /\\midrule\b/.test(body),
    bottom: /\\bottomrule\b/.test(body),
  };
  const dataBody = body
    .replace(/\\(?:toprule|midrule|bottomrule|hline)\b/g, '')
    .trim();
  const rows = splitTableRows(dataBody)
    .map((row) => splitTableCells(row).map(cleanTableCellForEditor))
    .filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) return null;
  const cols = Math.max(...rows.map((row) => row.length));
  return {
    centered: !!centerMatch,
    env: match[1],
    colspec: match[2],
    rules,
    rows: rows.map((row) => [...row, ...Array(cols - row.length).fill('')]),
  };
}

function splitTableRows(body) {
  const rows = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '\\') {
      rows.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += body[i];
  }
  if (current.trim()) rows.push(current.trim());
  return rows;
}

function splitTableCells(row) {
  const cells = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      current += ch + row[i + 1];
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === '&' && depth === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function cleanTableCellForEditor(cell) {
  return cell
    .replace(/\\textbf\{([^{}]*)\}/g, '$1')
    .replace(/\\emph\{([^{}]*)\}/g, '$1')
    .trim();
}

function tableRowsToText(rows) {
  return rows.map((row) => row.join('\t')).join('\n');
}

function tableTextToRows(text) {
  const rows = parsePastedTable(text);
  return rows.length ? rows : [['']];
}

function parseTheoremLikeLens(raw) {
  const match = raw.match(/^(\s*)\\begin\{(theorem|lemma|definition|proof)\}(\[[^\]]*\])?\s*([\s\S]*?)\s*\\end\{\2\}\s*$/);
  if (!match) return null;
  const env = match[2];
  let body = match[4].trim();
  const labelMatch = body.match(/\\label\{([^{}]*)\}/);
  const label = labelMatch?.[1] ?? '';
  if (labelMatch) body = (body.slice(0, labelMatch.index) + body.slice(labelMatch.index + labelMatch[0].length)).trim();
  return {
    env,
    title: match[3] ? match[3].slice(1, -1) : '',
    label,
    body: stripEditableParagraph(body),
  };
}

function buildWordModelSource(model, form) {
  const body = form.querySelector('[data-word-field="body"]')?.value ?? '';
  const label = form.querySelector('[data-word-field="label"]')?.value?.trim() ?? '';
  if (model.kind === 'heading') {
    const title = form.querySelector('[data-word-field="title"]')?.value?.trim() || '見出し';
    const command = model.command || 'section';
    return `\\${command}{${escapeLatexText(title)}}${label ? `\n\\label{${label}}` : ''}\n`;
  }
  if (model.kind === 'math') {
    const lens = { ...model.lens };
    const math = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' \\\\\n');
    return rebuildMathLens(lens, { math, label: label || null });
  }
  if (model.kind === 'code') {
    const title = form.querySelector('[data-word-field="title"]')?.value?.trim() || 'Source code';
    return buildCodeBlockTex(title, body, model.lens);
  }
  if (model.kind === 'quote') {
    return `\\begin{quote}\n${escapeLatexText(body)}\n\\end{quote}\n`;
  }
  if (model.kind === 'list') {
    return buildListTex(model.env, body);
  }
  if (model.kind === 'alignment') {
    return buildAlignmentTex(model.env, body);
  }
  if (model.kind === 'theoremLike') {
    if (model.env === 'proof') return `\\begin{proof}\n${escapeLatexText(body)}\n\\end{proof}\n`;
    const title = form.querySelector('[data-word-field="title"]')?.value?.trim() || '';
    const labelText = label || `${regionLabelPrefix(model.env)}:${slugifyLabel(title || body.slice(0, 32) || model.env)}`;
    return buildTheoremLikeTex(model.env, title, body, labelText);
  }
  if (model.kind === 'float') {
    const title = form.querySelector('[data-word-field="title"]')?.value?.trim() || (model.floatEnv === 'figure' ? '図' : '表');
    let next = setCommandArgument(model.raw, 'caption', escapeLatexText(title));
    next = setCommandArgument(next, 'label', label, { removeWhenEmpty: true });
    return next;
  }
  if (model.kind === 'simpleTable') {
    return buildSimpleTableTex(model.lens, tableTextToRows(body));
  }
  return body.trim() + '\n';
}

function buildSimpleTableTex(lens, rows) {
  const bodyLines = [];
  if (lens.rules?.top) bodyLines.push('\\toprule');
  rows.forEach((row, index) => {
    bodyLines.push(row.map((cell) => escapeLatexText(cell)).join(' & ') + ' \\\\');
    if (index === 0 && lens.rules?.mid) bodyLines.push('\\midrule');
  });
  if (lens.rules?.bottom) bodyLines.push('\\bottomrule');
  const table = `\\begin{${lens.env}}{${lens.colspec}}\n${bodyLines.join('\n')}\n\\end{${lens.env}}\n`;
  if (!lens.centered) return table;
  return `\\begin{center}\n${table}\\end{center}\n`;
}

function buildCodeBlockTex(title, body, lens = {}) {
  const start = lens.lines === false ? '\\KKcodeS' : '\\KKcodeS+';
  return `\\paragraph{${escapeLatexText(title)}}\n${start}\n${sanitizeKkluaverbCode(String(body).replace(/\r\n?/g, '\n'))}\n\\KKcodeE\n`;
}

function commandArgumentValue(source, command) {
  const span = commandArgumentSpan(source, command);
  return span ? source.slice(span.contentStart, span.contentEnd) : null;
}

function commandArgumentSpan(source, command) {
  const re = new RegExp(`\\\\${command}\\b`);
  const match = source.match(re);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (/\s/.test(source[i] ?? '')) i++;
  while (source[i] === '[') {
    const opt = readBalanced(source, i, '[', ']');
    if (!opt) return null;
    i = opt.end;
    while (/\s/.test(source[i] ?? '')) i++;
  }
  if (source[i] !== '{') return null;
  const arg = readBalanced(source, i, '{', '}');
  if (!arg) return null;
  return { ...arg, fullStart: match.index, fullEnd: arg.end };
}

function setCommandArgument(source, command, value, options = {}) {
  const span = commandArgumentSpan(source, command);
  if (!value && options.removeWhenEmpty) {
    if (!span) return source;
    return source.slice(0, span.fullStart).replace(/[ \t]*$/, '') + source.slice(span.fullEnd).replace(/^\s*\n?/, '\n');
  }
  if (span) return source.slice(0, span.contentStart) + value + source.slice(span.contentEnd);
  const endEnv = source.match(/\\end\{(?:figure|table)\}/);
  const insertAt = endEnv ? endEnv.index : source.length;
  return source.slice(0, insertAt).trimEnd() + `\n\\${command}{${value}}\n` + source.slice(insertAt);
}

function autosizeWordTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight + 2, 260) + 'px';
}

function saveWordEditor() {
  const form = wordEditorBodyEl?.querySelector('.word-form');
  const src = form?.dataset.src;
  if (!src) return;
  const block = workspaceBlocks.get(src);
  if (!block?.span) return;
  const model = wordModelFromSource(blockSource(block, editor.value), block);
  if (!model) return;
  const next = buildWordModelSource(model, form);
  let source = editor.value.slice(0, block.span.start) + next + editor.value.slice(block.span.end);
  if (/\\KKverb\b|\\KKcodeS\+?\b/.test(next)) source = ensurePackage(source, 'kkluaverb');
  if (/\\underLine\b/.test(next)) source = ensurePackage(source, 'lua-ul');
  if (/\\textcolor\b/.test(next)) source = ensurePackage(source, 'xcolor');
  if (/\\href\b/.test(next)) source = ensurePackage(source, 'hyperref');
  if (/\\begin\{(?:theorem|lemma|definition|proof)\}/.test(next)) {
    source = ensurePackage(source, 'amsthm');
    const envs = [...next.matchAll(/\\begin\{(theorem|lemma|definition)\}/g)].map((match) => match[1]);
    if (envs.length) source = ensureTheoremEnvironments(source, envs);
  }
  editor.value = source;
  selectedWordBlockId = src;
  scheduleSync();
  statusEl.textContent = '編集内容をTeXへ反映しました';
}

function wrapWordSelection(format) {
  const textarea = activeWordTextarea;
  if (!textarea) return;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const selected = textarea.value.slice(start, end) || formatDefaultText(format);
  const wrapped = wordFormatText(format, selected);
  textarea.setRangeText(wrapped, start, end, 'select');
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function formatDefaultText(format) {
  if (format === 'description') return '項目1: 内容1\n項目2: 内容2';
  if (format === 'itemize' || format === 'enumerate') return '項目1\n項目2';
  if (format === 'quote') return '引用文';
  if (format === 'footnote') return '脚注の内容';
  if (format === 'link') return 'https://example.com';
  if (format === 'center' || format === 'flushleft' || format === 'flushright') return '配置する文章';
  return 'テキスト';
}

function wordFormatText(format, text) {
  if (format === 'bold') return `\\textbf{${text}}`;
  if (format === 'italic') return `\\emph{${text}}`;
  if (format === 'underline') return `\\underLine{${text}}`;
  if (format === 'smallcaps') return `\\textsc{${text}}`;
  if (format === 'superscript') return `\\textsuperscript{${text}}`;
  if (format === 'color-blue') return `\\textcolor{blue}{${text}}`;
  if (format === 'code') return `\\KKverb|${String(text).replace(/\|/g, '/')}|`;
  if (format === 'footnote') return `\\footnote{${text}}`;
  if (format === 'link') {
    const value = String(text).trim();
    const url = /^https?:\/\//.test(value) ? value : 'https://example.com';
    const label = /^https?:\/\//.test(value) ? value : text;
    return `\\href{${url}}{${label}}`;
  }
  if (format === 'quote') return `\\begin{quote}\n${text}\n\\end{quote}`;
  if (format === 'center' || format === 'flushleft' || format === 'flushright') {
    return `\\begin{${format}}\n${text}\n\\end{${format}}`;
  }
  if (format === 'itemize' || format === 'enumerate' || format === 'description') {
    const env = format;
    const items = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return buildListTex(env, items.join('\n')).trim();
  }
  return text;
}

wordEditorEl?.addEventListener('click', (ev) => {
  const formatButton = ev.target.closest('[data-word-format]');
  if (formatButton) {
    wrapWordSelection(formatButton.dataset.wordFormat);
    return;
  }
  if (ev.target.closest('[data-word-save]')) {
    saveWordEditor();
    return;
  }
  const preview = ev.target.closest('[data-word-preview]');
  if (preview) {
    focusPreviewBlock(preview.dataset.wordPreview);
  }
});

function focusPreviewBlock(src) {
  setWorkspaceMode('edit');
  const el = document.querySelector(`[data-src="${src}"]`);
  const pageDiv = el?.closest?.('.page');
  if (pageDiv) pageDiv.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  const block = workspaceBlocks.get(src);
  const source = block ? blockSource(block, editor.value) : '';
  if (canOpenLensFromWorkspace(source)) {
    openBox(src);
  } else {
    closeBox();
    statusEl.textContent = 'このブロックはプレビュー上で確認できます。コード編集は「コード」画面から開けます';
  }
}

function canOpenLensFromWorkspace(source) {
  if (!source.trim()) return false;
  if (/\\tableofcontents\b/.test(source)) return false;
  return !!(parseMathLens(source) || parseInlineMathLenses(source).length || parseCommandLens(source) || previewWordModelFromSource(source));
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
  div.querySelectorAll('.hitbox').forEach((e) => e.remove());

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
          `<img class="chunk" src="/chunk/${encodeURIComponent(cmd.chunk)}.svg?v=${cmd.cv ?? 0}" style="margin-top:-${shiftPct}%" draggable="false"></div>`
      );
    }
    renderHitboxes(div, dl);
  } else {
    div.insertAdjacentHTML('beforeend', chunkSheet(dl));
    renderHitboxes(div, dl);
  }

  if (flash) {
    div.classList.remove('fading');
    div.classList.add('patched');
    requestAnimationFrame(() => div.classList.add('fading'));
    setTimeout(() => div.classList.remove('patched', 'fading'), 1200);
  }
}

function renderHitboxes(pageDiv, dl) {
  const W = geometry.paperwidth;
  const H = geometry.paperheight;
  for (const cmd of dl.commands) {
    if (cmd.op !== 'hitbox') continue;
    const layoutAttr = cmd.layout ? ` data-layout="${escapeHtml(cmd.layout)}"` : '';
    const columnAttr = Number.isFinite(cmd.column) ? ` data-column="${cmd.column}"` : '';
    pageDiv.insertAdjacentHTML(
      'beforeend',
      `<div class="hitbox" data-src="${escapeHtml(cmd.src)}"${layoutAttr}${columnAttr} style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%"></div>`
    );
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
          `<img class="chunk" src="/chunk/${encodeURIComponent(cmd.chunk)}.svg" style="margin-top:-${shift}%" draggable="false">` +
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
      const layoutAttr = cmd.layout ? ` data-layout="${escapeHtml(cmd.layout)}"` : '';
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}"${layoutAttr} xml:space="preserve">${escapeXml(cmd.text)}</text>`
      );
    } else if (cmd.op === 'rule') {
      const layoutAttr = cmd.layout ? ` data-layout="${escapeHtml(cmd.layout)}"` : '';
      parts.push(
        `<rect x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.1)}" height="${Math.max(cmd.h, 0.1)}" fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}"${layoutAttr}/>`
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
  refreshWorkspace();
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
  syncEditorHighlight();
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
      const exactPending = report.stats.fullPagePreviewPending ? ' / exact更新中' : '';
      statusEl.textContent =
        `update #${report.rev} [${backend}] — ${engineMs} / 往復 ${rtt.toFixed(0)} ms` +
        exactPending +
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
  syncEditorHighlight();
  scheduleSync();
});
editor.addEventListener('input', () => {
  syncEditorHighlight();
  if (!composing) scheduleSync();
});
editor.addEventListener('scroll', syncEditorHighlight);

// Preview interactions:
//   click     -> PowerPoint-style box editing right on the page
//   Alt+click -> jump to the source in the left editor (legacy behavior)
pagesEl.addEventListener('click', async (ev) => {
  const hit = sourceHitFromEvent(ev);
  const src = hit?.src;
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
  openBox(src, hit.el ?? ev.target, { x: ev.clientX, y: ev.clientY });
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

// ---------------------------------------------------------------- workspace modes

function setWorkspaceMode(mode) {
  document.querySelectorAll('.mode-btn').forEach((button) => {
    const active = button.dataset.workspace === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.querySelectorAll('.workspace-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === mode);
  });
  if (mode === 'code') {
    renderCodeFileList(editor.value);
    if (!pendingCodeFile && !selectedCodeFile) {
      renderCodeFilePreview('', '');
      if (codePickedFileEl) codePickedFileEl.textContent = '未選択';
    }
  }
}

document.getElementById('mode-nav')?.addEventListener('click', (ev) => {
  const button = ev.target.closest('.mode-btn');
  if (!button) return;
  setWorkspaceMode(button.dataset.workspace);
});

layoutViewEl?.addEventListener('change', () => {
  applyLayoutView(layoutViewEl.value);
  applySplitRatio();
});
enhanceTopbarSelect(layoutViewEl);
enhanceTopbarSelect(templateSelectEl);
layoutSplitterEl?.addEventListener('pointerdown', beginLayoutResize);
layoutSplitterEl?.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    nudgeLayoutSplit(-2);
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    nudgeLayoutSplit(2);
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    applySplitRatio(35);
  } else if (ev.key === 'End') {
    ev.preventDefault();
    applySplitRatio(70);
  }
});
window.addEventListener('resize', () => applySplitRatio());
menuToggleButton?.addEventListener('click', () => setMenuCollapsed(!document.body.classList.contains('menu-collapsed')));
applyLayoutView();
applySplitRatio();
setMenuCollapsed(false);

// ---------------------------------------------------------------- AI assist

function selectedAiMode() {
  return document.querySelector('input[name="ai-mode"]:checked')?.value ?? 'paragraph';
}

function selectedAiLane() {
  return document.querySelector('input[name="ai-lane"]:checked')?.value ?? 'body';
}

function aiModeScope(mode) {
  return ['sty-integration', 'macro-design', 'box-design', 'page-style'].includes(mode) ? 'design' : 'body';
}

function isAiDesignDraft(draft) {
  return draft?.aiScope === 'design';
}

function setAiCommandOptionsForLane(lane) {
  if (!aiCommandEl) return;
  const designCommands = new Set(['auto', 'style-package', 'macro', 'tcolorbox', 'page-style']);
  for (const option of aiCommandEl.options) {
    option.hidden = lane === 'design' ? !designCommands.has(option.value) : false;
  }
  if (aiCommandEl.selectedOptions[0]?.hidden) aiCommandEl.value = 'auto';
}

function updateAiLaneUi() {
  const lane = selectedAiLane();
  document.querySelectorAll('[data-ai-lane]').forEach((label) => {
    label.classList.toggle('is-active', label.dataset.aiLane === lane);
  });
  for (const label of aiModeLabels) {
    label.hidden = label.dataset.aiScope !== lane;
  }
  const checkedMode = selectedAiMode();
  if (aiModeScope(checkedMode) !== lane) {
    const first = document.querySelector(`[data-ai-scope="${lane}"] input[name="ai-mode"]`);
    if (first) first.checked = true;
  }
  setAiCommandOptionsForLane(lane);
  document.getElementById('ai-assistant-message')?.replaceChildren(document.createTextNode(aiIntroText(lane)));
  if (aiPromptEl) {
    aiPromptEl.placeholder =
      lane === 'design'
        ? '例: 注意書き用の角丸tcolorboxを作りたい / uploads/my-style.sty を使いたい'
        : '追加・整理したい本文を入力';
  }
}

function aiIntroText(lane = selectedAiLane()) {
  return lane === 'design'
    ? '持ち込み.sty、独自マクロ、tcolorbox、柱などの意匠案を作り、サンプルを実コンパイルしたPDFで確認します。'
    : '本文に入れたい内容を送ると、擬似PDFに追加できるTeX候補を作ります。';
}

function renderAiConversation(draft = null) {
  if (!aiDialogEl) return;
  const intro = aiIntroText();
  if (!draft) {
    aiDialogEl.innerHTML = `<div class="ai-message ai-message-assistant" id="ai-assistant-message">${escapeHtml(intro)}</div>`;
    return;
  }
  const scope = isAiDesignDraft(draft) ? 'design' : 'body';
  const previewLabel = scope === 'design' ? '実コンパイルPDFで確認' : '擬似PDFへ追加';
  const destinationLabel = draft.preambleOnly ? 'プリアンブル' : scope === 'design' ? 'プリアンブル＋サンプル' : '本文';
  const packageChips = (draft.packages ?? []).map((name) => `<span class="ai-chip">\\usepackage{${escapeHtml(name)}}</span>`).join('');
  aiDialogEl.innerHTML = `
    <div class="ai-message ai-message-assistant">${escapeHtml(intro)}</div>
    <div class="ai-message ai-message-user">${escapeHtml(aiLastPrompt || '新しい内容')}</div>
    <div class="ai-message ai-message-assistant ai-message-draft">
      <div class="ai-message-title">${escapeHtml(draft.title)}</div>
      <div class="ai-message-body">${escapeHtml(draft.preview)}</div>
      <div class="ai-chip-row">
        <span class="ai-chip">${escapeHtml(destinationLabel)}</span>
        <span class="ai-chip">${escapeHtml(previewLabel)}</span>
        ${packageChips}
      </div>
    </div>
  `;
}

function switchAiLane(lane) {
  const laneInput = document.querySelector(`input[name="ai-lane"][value="${lane}"]`);
  if (laneInput) laneInput.checked = true;
  const modeInput = document.querySelector(`[data-ai-scope="${lane}"] input[name="ai-mode"]`);
  if (modeInput) modeInput.checked = true;
  if (aiCommandEl) aiCommandEl.value = 'auto';
  aiDraft = null;
  updateAiLaneUi();
  renderAiDraft(null);
}

function selectedAiCommand(mode, prompt) {
  const selected = aiCommandEl?.value || 'auto';
  if (selected !== 'auto') return selected;
  if (/tcolorbox|box|枠|囲み|注意|コラム/i.test(prompt)) return 'tcolorbox';
  if (/柱|ヘッダ|ヘッダー|フッタ|フッター|ノンブル|版面|page\s*style/i.test(prompt)) return 'page-style';
  if (/マクロ|macro|\\newcommand|\\renewcommand|コマンド/i.test(prompt)) return 'macro';
  if (/\.sty\b|\\usepackage|package|スタイルファイル/i.test(prompt)) return 'style-package';
  if (mode === 'structure') return 'section';
  if (mode === 'sty-integration') return 'style-package';
  if (mode === 'macro-design') return 'macro';
  if (mode === 'box-design') return 'tcolorbox';
  if (mode === 'page-style') return 'page-style';
  if (/```|function |const |class |import |def /i.test(prompt)) return 'code';
  if (/\|.*\||表|table/i.test(prompt)) return 'table';
  if (/^\s*[^:：\n]+[:：]\s+.+$/m.test(prompt) || /説明リスト|description/i.test(prompt)) return 'description';
  if (/^[-*]\s+/m.test(prompt)) return 'itemize';
  if (/^\d+[.)]\s+/m.test(prompt)) return 'enumerate';
  if (/^>|\bquote\b|引用/.test(prompt)) return 'quote';
  return 'paragraph';
}

function aiModeForCommand(command, fallback = selectedAiMode()) {
  if (command === 'style-package') return 'sty-integration';
  if (command === 'macro') return 'macro-design';
  if (command === 'tcolorbox') return 'box-design';
  if (command === 'page-style') return 'page-style';
  if (command === 'section' || command === 'subsection') return 'structure';
  return fallback;
}

function syncAiModeToCommand(command) {
  const mode = aiModeForCommand(command);
  const input = document.querySelector(`input[name="ai-mode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
    const laneInput = document.querySelector(`input[name="ai-lane"][value="${aiModeScope(mode)}"]`);
    if (laneInput) laneInput.checked = true;
    updateAiLaneUi();
  }
}

function renderAiDraft(draft) {
  if (!aiResultEl) return;
  if (!draft) {
    aiResultEl.className = 'ai-result is-empty';
    aiResultEl.textContent = '候補はまだありません';
    aiInsertButton.disabled = true;
    renderAiPdfPreview(null);
    renderAiConversation(null);
    return;
  }
  aiResultEl.className = 'ai-result ai-draft-card';
  aiResultEl.innerHTML = `
    <div class="ai-result-title">生成されるTeX</div>
    <div class="ai-result-body">${escapeHtml(draft.preambleTex ? `${draft.preambleTex}\n${draft.tex || ''}` : draft.tex || draft.previewTex || draft.preview)}</div>
  `;
  aiInsertButton.disabled = false;
  renderAiConversation(draft);
}

function renderAiPdfPreview(state) {
  if (!aiPreviewStageEl) return;
  if (!state) {
    aiPreviewStageEl.className = 'ai-preview-stage is-hidden';
    aiPreviewStageEl.innerHTML = '';
    pagesEl?.classList.remove('is-backgrounded');
    return;
  }
  aiPreviewStageEl.className = `ai-preview-stage ${state.error ? 'has-error' : ''}`;
  pagesEl?.classList.add('is-backgrounded');
  if (state.loading) {
    aiPreviewStageEl.innerHTML = '<div class="ai-preview-status">LuaLaTeXでPDFプレビューを作成中…</div>';
    return;
  }
  if (state.error) {
    aiPreviewStageEl.innerHTML = `
      <div class="ai-preview-status">PDFプレビューを作成できませんでした</div>
      <pre>${escapeHtml(state.error)}</pre>
    `;
    return;
  }
  aiPreviewStageEl.innerHTML = `
    <div class="ai-preview-status">実コンパイルPDFプレビュー</div>
    <iframe title="AI style PDF preview" src="${escapeHtml(state.url)}"></iframe>
  `;
}

function sourceWithAiDraft(source, draft) {
  let out = source;
  for (const packageName of draft.packages ?? []) out = ensurePackage(out, packageName);
  if (draft.theoremEnvs?.length) out = ensureTheoremEnvironments(out, draft.theoremEnvs);
  if (draft.preambleTex) out = insertPreambleSnippet(out, draft.preambleTex);
  const sample = draft.tex || draft.previewTex || '\n\\section{AI Style Preview}\nこの文書の意匠プレビューです。\n';
  return sample ? insertTexAtTarget(out, sample, 'end') : out;
}

async function compileAiPdfPreview(draft) {
  if (!isAiDesignDraft(draft)) {
    renderAiPdfPreview(null);
    return;
  }
  renderAiPdfPreview({ loading: true });
  try {
    const res = await fetch('/ai-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceWithAiDraft(editor.value, draft) }),
    });
    const payload = await res.json();
    if (!res.ok || payload.error) throw new Error(payload.error || `HTTP ${res.status}`);
    renderAiPdfPreview({ url: payload.url });
  } catch (err) {
    renderAiPdfPreview({ error: err.message || String(err) });
  }
}

function buildAiDraft(mode, prompt, commandOverride = null) {
  const text = prompt.trim() || '新しい内容';
  const command = commandOverride || selectedAiCommand(mode, text);
  const title = text.split(/[。.\n]/)[0].replace(/^[-*>0-9.)\s]+/, '').trim().slice(0, 48) || '新しい項目';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const listItems = lines
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter(Boolean);
  if (command === 'style-package') {
    const packageName = packageNameFromPrompt(text);
    return {
      title: `.sty統合: ${packageName}`,
      preview: `\\usepackage{${packageName}} をプリアンブルへ追加します。\n持ち込み .sty はコードメニューからファイル選択で保存できます。`,
      tex: '',
      packages: [packageName],
      preambleOnly: true,
      aiScope: 'design',
      previewTex:
        '\n\\section{Style Preview}\n' +
        'このページは持ち込みスタイルを読み込んだ状態のサンプルです。\n\n' +
        '\\begin{itemize}\n  \\item 見出し、本文、箇条書きの見え方\n  \\item 数式 $E=mc^2$ と参照用テキスト\n\\end{itemize}\n',
    };
  }
  if (command === 'macro') {
    const name = macroNameFromPrompt(text);
    const argCount = /2|二|ふたつ|two/i.test(text) ? 2 : /0|引数なし|no arg/i.test(text) ? 0 : 1;
    const args = argCount ? `[${argCount}]` : '';
    const body = argCount === 0 ? escapeLatexText(title) : argCount === 2 ? '\\textbf{#1}: #2' : '\\textbf{#1}';
    return {
      title: `独自マクロ: \\${name}`,
      preview: `プリアンブルに \\newcommand{\\${name}} を追加します。\n本文には使用例を置きます。`,
      preambleTex: `\\newcommand{\\${name}}${args}{${body}}`,
      tex: argCount === 0 ? `\n\\${name}\n` : argCount === 2 ? `\n\\${name}{${escapeLatexText(title)}}{${escapeLatexText(text)}}\n` : `\n\\${name}{${escapeLatexText(title)}}\n`,
      packages: [],
      aiScope: 'design',
    };
  }
  if (command === 'tcolorbox') {
    const envName = environmentNameFromPrompt(text, 'designbox');
    return {
      title: `独自tcolorbox: ${envName}`,
      preview: `tcolorbox の独自環境 ${envName} を作成し、使用例を本文に追加します。`,
      preambleTex:
        `\\tcbuselibrary{skins,breakable}\n` +
        `\\newtcolorbox{${envName}}[1][]{enhanced,breakable,colback=blue!3,colframe=blue!55!black,boxrule=0.7pt,arc=2pt,left=8pt,right=8pt,top=7pt,bottom=7pt,fonttitle=\\bfseries,title=#1}`,
      tex: `\n\\begin{${envName}}[${escapeLatexText(title)}]\n${escapeLatexText(text)}\n\\end{${envName}}\n`,
      packages: ['tcolorbox'],
      aiScope: 'design',
    };
  }
  if (command === 'page-style') {
    const header = escapeLatexText(title || 'Document');
    return {
      title: '柱デザイン',
      preview: `fancyhdr で柱・ノンブルの基本デザインをプリアンブルへ追加します。\n左柱: ${title}`,
      preambleTex:
        `\\usepackage{lastpage}\n` +
        `\\pagestyle{fancy}\n` +
        `\\fancyhf{}\n` +
        `\\fancyhead[L]{${header}}\n` +
        `\\fancyhead[R]{\\leftmark}\n` +
        `\\fancyfoot[C]{\\thepage/\\pageref{LastPage}}\n` +
        `\\renewcommand{\\headrulewidth}{0.4pt}`,
      tex: '',
      packages: ['fancyhdr'],
      preambleOnly: true,
      aiScope: 'design',
      previewTex:
        '\n\\section{Page Style Preview}\n' +
        '柱、ノンブル、本文領域の見え方を確認するためのサンプルです。\n\n' +
        '本文が複数ページに流れたときの余白とヘッダーを確認します。\n\\newpage\n' +
        '\\section{Second Page}\n二ページ目の柱とノンブルを確認します。\n',
    };
  }
  if (command === 'section' || command === 'subsection') {
    const heading = command === 'section' ? 'section' : 'subsection';
    return {
      title: `${command === 'section' ? '節' : '小節'}: ${title}`,
      preview: `\\${heading}{...} と \\label{...} を作り、本文を追加します。\n${text}`,
      tex: `\n\\${heading}{${escapeLatexText(title)}}\n\\label{sec:${slugifyLabel(title)}}\n\n${escapeLatexText(text)}\n`,
      packages: [],
    };
  }
  if (command === 'equation') {
    return {
      title: '数式',
      preview: `equation 環境として追加します。\n${text}`,
      tex: `\n\\begin{equation}\n  \\label{eq:${slugifyLabel(title)}}\n  ${escapeLatexMath(text)}\n\\end{equation}\n`,
      packages: ['amsmath'],
    };
  }
  if (command === 'align') {
    const mathLines = (lines.length ? lines : [text]).map((line, index, arr) => `  ${escapeLatexMath(line)}${index < arr.length - 1 ? ' \\\\' : ''}`);
    return {
      title: '整列数式',
      preview: `align 環境として追加します。\n${mathLines.join('\n')}`,
      tex: `\n\\begin{align}\n  \\label{eq:${slugifyLabel(title)}}\n${mathLines.join('\n')}\n\\end{align}\n`,
      packages: ['amsmath'],
    };
  }
  if (command === 'itemize' || command === 'enumerate' || command === 'description') {
    const env = command;
    const items =
      command === 'description'
        ? buildListTex(env, (listItems.length ? listItems : lines.length ? lines : [text]).join('\n')).trim()
        : `\\begin{${env}}\n${(listItems.length ? listItems : [text]).map((item) => `  \\item ${escapeLatexText(item)}`).join('\n')}\n\\end{${env}}`;
    return {
      title: listEnvironmentLabel(env),
      preview: `${env} 環境として追加します。\n${items.replace(/^\\begin\{[^{}]+\}\n?|\n?\\end\{[^{}]+\}$/g, '').trim()}`,
      tex: `\n${items}\n`,
      packages: [],
    };
  }
  if (command === 'quote') {
    return {
      title: '引用',
      preview: `quote 環境として追加します。\n${text}`,
      tex: `\n\\begin{quote}\n${escapeLatexText(text.replace(/^>\s?/gm, ''))}\n\\end{quote}\n`,
      packages: [],
    };
  }
  if (['theorem', 'lemma', 'definition'].includes(command)) {
    return {
      title: `${theoremEnvironmentLabel(command)}: ${title}`,
      preview: `${command} 環境として追加します。\n${text}`,
      tex: buildTheoremLikeTex(command, title, text, `thm:${slugifyLabel(title)}`),
      packages: ['amsthm'],
      theoremEnvs: [command],
    };
  }
  if (command === 'proof') {
    return {
      title: '証明',
      preview: `proof 環境として追加します。\n${text}`,
      tex: `\n\\begin{proof}\n${escapeLatexText(text)}\n\\end{proof}\n`,
      packages: ['amsthm'],
    };
  }
  if (command === 'table') {
    const rows = parseAiTableRows(text);
    return {
      title: '表',
      preview: `tabularray の tblr として追加します。\n${rows.map((row) => row.join(' | ')).join('\n')}`,
      tex: buildAiTableTex(rows, title),
      packages: ['tabularray'],
    };
  }
  if (command === 'code') {
    return {
      title: 'コード',
      preview: `kkluaverb のコードブロックとして追加します。\n${text}`,
      tex: '\n' + buildCodeBlockTex(title, stripCodeFence(text), { lines: true }),
      packages: ['kkluaverb'],
    };
  }
  return {
    title: '文章',
    preview: `${text}\n\n通常の本文ブロックとして追加します。`,
    tex: `\n${escapeLatexText(text)}\n`,
    packages: [],
  };
}

function parseAiTableRows(text) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\||\|$/g, '').split(/\s*\|\s*|\s*,\s*/).map((cell) => cell.trim()).filter(Boolean))
    .filter((row) => row.length);
  return rows.length ? rows : [['項目', '値'], ['Alpha', '1']];
}

function buildAiTableTex(rows, title) {
  const cols = Math.max(...rows.map((row) => row.length), 1);
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, cols - row.length)).fill('')]);
  const body = normalized.map((row) => row.map((cell) => escapeLatexText(cell)).join(' & ') + ' \\\\').join('\n');
  return `\n\\begin{table}[htbp]\n\\centering\n\\caption{${escapeLatexText(title)}}\n\\begin{tblr}{colspec={${'X'.repeat(cols)}},hlines,vlines,row{1}={font=\\bfseries}}\n${body}\n\\end{tblr}\n\\end{table}\n`;
}

function stripCodeFence(text) {
  return String(text).replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
}

function escapeLatexText(text) {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function escapeLatexMath(text) {
  if (/\\|[_^{}]/.test(text)) return text;
  return escapeLatexText(text);
}

function slugifyLabel(text) {
  const ascii = text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return ascii || `item-${Date.now().toString(36)}`;
}

function identifierFromText(text, fallback) {
  const ascii = String(text || '')
    .normalize('NFKD')
    .replace(/\\[a-zA-Z@]+/g, ' ')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+(.)/g, (_, ch) => ch.toUpperCase())
    .replace(/^[^a-zA-Z]+/, '');
  return ascii || fallback;
}

function packageNameFromPrompt(text) {
  const file = String(text || '').match(/[A-Za-z0-9_./-]+\.sty\b/);
  if (file) return file[0].replace(/\.sty$/i, '');
  const pkg = String(text || '').match(/\\usepackage(?:\[[^\]]*\])?\{([^{}]+)\}/);
  if (pkg) return pkg[1].trim();
  return identifierFromText(text, 'customstyle').toLowerCase();
}

function macroNameFromPrompt(text) {
  const command = String(text || '').match(/\\([A-Za-z@][A-Za-z0-9@]*)/);
  if (command) return command[1];
  return identifierFromText(text, 'customMacro');
}

function environmentNameFromPrompt(text, fallback) {
  const env = String(text || '').match(/\\begin\{([A-Za-z][A-Za-z0-9*_-]*)\}/);
  if (env) return env[1].replace(/[^A-Za-z0-9]/g, '');
  const name = identifierFromText(text, fallback);
  if (['tcolorbox', 'box', 'document'].includes(name.toLowerCase())) return fallback;
  return name;
}

function insertAiDraft() {
  if (!aiDraft) return;
  let source = editor.value;
  for (const packageName of aiDraft.packages ?? []) source = ensurePackage(source, packageName);
  if (aiDraft.theoremEnvs?.length) source = ensureTheoremEnvironments(source, aiDraft.theoremEnvs);
  if (aiDraft.preambleTex) source = insertPreambleSnippet(source, aiDraft.preambleTex);
  editor.value = aiDraft.tex ? insertTexAtTarget(source, aiDraft.tex, aiTargetEl?.value || 'end') : source;
  scheduleSync();
  statusEl.textContent = 'AI候補を文書に追加しました';
  aiDraft = null;
  renderAiDraft(null);
  setWorkspaceMode('edit');
}

aiDraftButton?.addEventListener('click', async () => {
  aiLastPrompt = aiPromptEl.value.trim() || '新しい内容';
  const command = selectedAiCommand(selectedAiMode(), aiLastPrompt);
  syncAiModeToCommand(command);
  aiDraft = buildAiDraft(selectedAiMode(), aiLastPrompt, command);
  renderAiDraft(aiDraft);
  await compileAiPdfPreview(aiDraft);
});

aiInsertButton?.addEventListener('click', insertAiDraft);
aiLaneInputs.forEach((input) => input.addEventListener('change', () => switchAiLane(input.value)));
document.querySelectorAll('input[name="ai-mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    const scope = aiModeScope(input.value);
    const laneInput = document.querySelector(`input[name="ai-lane"][value="${scope}"]`);
    if (laneInput) laneInput.checked = true;
    updateAiLaneUi();
  });
});

updateAiLaneUi();
renderAiDraft(null);

// ---------------------------------------------------------------- insert builder

function regionLabelPrefix(type) {
  if (type === 'equation' || type === 'align') return 'eq';
  if (type === 'section' || type === 'subsection') return 'sec';
  if (type === 'theorem') return 'thm';
  if (type === 'lemma') return 'lem';
  if (type === 'definition') return 'def';
  return 'blk';
}

function normalizeRegionLabel(type, title) {
  const raw = regionLabelEl?.value?.trim();
  if (raw) return raw;
  return `${regionLabelPrefix(type)}:${slugifyLabel(title || 'item')}`;
}

function buildRegionTex() {
  const type = regionTypeEl?.value || 'paragraph';
  const title = regionTitleEl?.value?.trim() || (type === 'paragraph' ? '' : '新しい項目');
  const body = regionBodyEl?.value?.trim() || (type === 'equation' || type === 'align' ? 'x = y' : 'ここに本文を入力します。');
  const label = normalizeRegionLabel(type, title || body.slice(0, 32));
  if (type === 'section') {
    return `\n\\section{${escapeLatexText(title)}}\n\\label{${label}}\n\n${escapeLatexText(body)}\n`;
  }
  if (type === 'subsection') {
    return `\n\\subsection{${escapeLatexText(title)}}\n\\label{${label}}\n\n${escapeLatexText(body)}\n`;
  }
  if (type === 'equation') {
    return `\n\\begin{equation}\n  \\label{${label}}\n  ${escapeLatexMath(body)}\n\\end{equation}\n`;
  }
  if (type === 'align') {
    const lines = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index, arr) => `  ${escapeLatexMath(line)}${index < arr.length - 1 ? ' \\\\' : ''}`);
    return `\n\\begin{align}\n  \\label{${label}}\n${lines.join('\n')}\n\\end{align}\n`;
  }
  if (type === 'quote') {
    return `\n\\begin{quote}\n${escapeLatexText(body)}\n\\end{quote}\n`;
  }
  if (type === 'center' || type === 'flushleft' || type === 'flushright') {
    return '\n' + buildAlignmentTex(type, body);
  }
  if (type === 'itemize' || type === 'enumerate' || type === 'description') {
    return '\n' + buildListTex(type, body);
  }
  if (['theorem', 'lemma', 'definition'].includes(type)) {
    return buildTheoremLikeTex(type, title, body, normalizeRegionLabel(type, title || body.slice(0, 32)));
  }
  if (type === 'proof') {
    return `\n\\begin{proof}\n${escapeLatexText(body)}\n\\end{proof}\n`;
  }
  return `\n${escapeLatexText(body)}\n`;
}

function buildListTex(env, body) {
  const items = String(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const marker = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (marker) return `  \\item[${escapeLatexText(marker[1].trim())}] ${escapeLatexText(marker[2].trim() || '項目')}`;
      if (env === 'description') {
        const pair = line.match(/^([^:：]+)[:：]\s*(.*)$/);
        if (pair) return `  \\item[${escapeLatexText(pair[1].trim())}] ${escapeLatexText(pair[2].trim() || '内容')}`;
        return `  \\item[${escapeLatexText(line)}] 内容`;
      }
      return `  \\item ${escapeLatexText(line)}`;
    });
  const safeItems = items.length ? items : [env === 'description' ? '  \\item[項目] 内容' : '  \\item 項目'];
  return `\\begin{${env}}\n${safeItems.join('\n')}\n\\end{${env}}\n`;
}

function buildAlignmentTex(env, body) {
  return `\\begin{${env}}\n${escapeLatexText(String(body).trim() || '配置する文章')}\n\\end{${env}}\n`;
}

function theoremEnvironmentLabel(type) {
  return { theorem: '定理', lemma: '補題', definition: '定義' }[type] || type;
}

function buildTheoremLikeTex(type, title, body, label) {
  const heading = title ? `[${escapeLatexText(title)}]` : '';
  const safeLabel = label || `thm:${slugifyLabel(title || body.slice(0, 32) || type)}`;
  return `\n\\begin{${type}}${heading}\n\\label{${safeLabel}}\n${escapeLatexText(body)}\n\\end{${type}}\n`;
}

function buildCodeTex() {
  const title = codeTitleEl?.value?.trim() || 'Source code';
  const body = codeBodyEl?.value || 'console.log("hello");';
  return '\n' + buildCodeBlockTex(title, body, { lines: !!codeLinesEl?.checked });
}

function sanitizeKkluaverbCode(code) {
  return String(code).replace(/\\KKcodeE/g, '\\KKcode E');
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const dataUrl = String(reader.result || '');
      resolve(dataUrl.includes(',') ? dataUrl.split(',').pop() : dataUrl);
    });
    reader.addEventListener('error', () => reject(reader.error || new Error('file read failed')));
    reader.readAsDataURL(file);
  });
}

async function uploadImageAsset(file) {
  const data = await readFileAsBase64(file);
  const res = await fetch('/assets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, data }),
  });
  const saved = await res.json();
  if (!res.ok || saved.error) throw new Error(saved.error || `HTTP ${res.status}`);
  return saved;
}

function buildImageFigureTex(asset) {
  const caption = imageCaptionEl?.value?.trim() || '追加した画像';
  const label = `fig:${slugifyLabel(caption)}`;
  const width = imageWidthEl?.value?.trim() || '0.8\\linewidth';
  return `\n\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=${width}]{${asset.texPath}}\n\\caption{${escapeLatexText(caption)}}\n\\label{${label}}\n\\end{figure}\n`;
}

function insertTexAtTarget(source, tex, targetId) {
  const trimmedTex = tex.replace(/^\n*/, '\n').replace(/\n*$/, '\n');
  if (targetId && targetId !== 'end') {
    const block = workspaceBlocks.get(targetId);
    if (block?.span) {
      const insertAt = block.span.end;
      return source.slice(0, insertAt).trimEnd() + trimmedTex + source.slice(insertAt);
    }
  }
  const insertAt = source.replace(/\s*\\end\{document\}\s*$/, '').length;
  return source.slice(0, insertAt).trimEnd() + trimmedTex + '\n\\end{document}\n';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renameReferenceLabel() {
  const oldName = refLabelSelectEl?.value?.trim();
  const newName = refLabelNameEl?.value?.trim();
  if (!oldName || !newName || oldName === newName) return;
  const pattern = new RegExp(`\\\\(label|ref|eqref|pageref)\\{${escapeRegExp(oldName)}\\}`, 'g');
  editor.value = editor.value.replace(pattern, (_match, command) => `\\${command}{${newName}}`);
  scheduleSync();
  statusEl.textContent = `ラベル ${oldName} を ${newName} に改名しました`;
}

function insertReferenceCommand() {
  const name = refLabelSelectEl?.value?.trim();
  if (!name) return;
  const command = refCommandEl?.value || 'ref';
  const label = referenceLabels.find((item) => item.name === name);
  const prefix = command === 'eqref' ? '式' : command === 'pageref' ? 'ページ' : '参照';
  const tex = `\n${prefix}~\\${command}{${name}}${label ? `（${escapeLatexText(label.owner.split('/')[0].trim())}）` : ''}。\n`;
  editor.value = insertTexAtTarget(editor.value, tex, refTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = `\\${command}{${name}} を追加しました`;
  setWorkspaceMode('edit');
}

function insertCitationCommand() {
  const key = citeKeySelectEl?.value?.trim();
  if (!key) {
    statusEl.textContent = '引用する文献を選んでください';
    return;
  }
  editor.value = insertTexAtTarget(editor.value, `\n引用~\\cite{${key}}。\n`, citeTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = `\\cite{${key}} を追加しました`;
  setWorkspaceMode('edit');
}

function populateBibliographyFields(key = citeKeySelectEl?.value) {
  const item = bibliographyItems.find((entry) => entry.key === key);
  if (!item) return;
  if (bibKeyEl) bibKeyEl.value = item.key;
  if (bibTextEl) bibTextEl.value = item.text;
}

function addBibliographyItem() {
  const key = bibKeyEl?.value?.trim();
  const text = bibTextEl?.value?.trim();
  if (!key || !text) {
    statusEl.textContent = '文献キーと文献情報を入力してください';
    return;
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
    statusEl.textContent = '文献キーには英数字と . _ : - が使えます';
    return;
  }
  const item = `\\bibitem{${key}} ${escapeLatexText(text)}\n`;
  let source = editor.value;
  if (new RegExp(`\\\\bibitem(?:\\[[^\\]]*\\])?\\{${escapeRegExp(key)}\\}`).test(source)) {
    statusEl.textContent = `文献キー ${key} はすでにあります`;
    return;
  }
  const envEnd = source.match(/\\end\{thebibliography\}/);
  if (envEnd) {
    source = source.slice(0, envEnd.index).trimEnd() + '\n' + item + source.slice(envEnd.index);
  } else {
    const bibliography = `\n\\begin{thebibliography}{9}\n${item}\\end{thebibliography}\n`;
    source = insertTexAtTarget(source, bibliography, 'end');
  }
  editor.value = source;
  if (bibKeyEl) bibKeyEl.value = '';
  if (bibTextEl) bibTextEl.value = '';
  scheduleSync();
  statusEl.textContent = `文献 ${key} を追加しました`;
  setWorkspaceMode('refs');
}

function updateBibliographyItem() {
  const oldKey = citeKeySelectEl?.value?.trim();
  const newKey = bibKeyEl?.value?.trim();
  const text = bibTextEl?.value?.trim();
  if (!oldKey || !newKey || !text) {
    statusEl.textContent = '更新する文献と文献情報を入力してください';
    return;
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(newKey)) {
    statusEl.textContent = '文献キーには英数字と . _ : - が使えます';
    return;
  }
  let source = editor.value;
  if (oldKey !== newKey && new RegExp(`\\\\bibitem(?:\\[[^\\]]*\\])?\\{${escapeRegExp(newKey)}\\}`).test(source)) {
    statusEl.textContent = `文献キー ${newKey} はすでにあります`;
    return;
  }
  const itemRe = new RegExp(`\\\\bibitem(\\[[^\\]]*\\])?\\{${escapeRegExp(oldKey)}\\}[\\s\\S]*?(?=\\\\bibitem(?:\\[[^\\]]*\\])?\\{|\\\\end\\{thebibliography\\})`);
  if (!itemRe.test(source)) {
    statusEl.textContent = `文献 ${oldKey} が見つかりません`;
    return;
  }
  source = source.replace(itemRe, `\\bibitem{${newKey}} ${escapeLatexText(text)}\n`);
  if (oldKey !== newKey) source = replaceCitationKey(source, oldKey, newKey);
  editor.value = source;
  scheduleSync();
  statusEl.textContent = `文献 ${oldKey} を更新しました`;
  setWorkspaceMode('refs');
}

function replaceCitationKey(source, oldKey, newKey) {
  const re = /\\cite\{([^{}]+)\}/g;
  return source.replace(re, (_match, keys) => {
    const next = keys
      .split(',')
      .map((key) => key.trim())
      .map((key) => (key === oldKey ? newKey : key))
      .join(',');
    return `\\cite{${next}}`;
  });
}

function insertReferenceListCommand() {
  const command = refListCommandEl?.value || 'tableofcontents';
  if (!['tableofcontents', 'listoffigures', 'listoftables'].includes(command)) return;
  const re = new RegExp(`\\\\${command}\\b`);
  if (re.test(editor.value)) {
    statusEl.textContent = `\\${command} はすでに文書にあります`;
    setWorkspaceMode('refs');
    return;
  }
  const titles = {
    tableofcontents: '目次',
    listoffigures: '図一覧',
    listoftables: '表一覧',
  };
  editor.value = insertTexAtTarget(editor.value, `\n\\${command}\n`, refListTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = `${titles[command]}を追加しました`;
  setWorkspaceMode('refs');
}

refLabelSelectEl?.addEventListener('change', () => {
  if (refLabelNameEl) refLabelNameEl.value = refLabelSelectEl.value;
});
refRenameButton?.addEventListener('click', renameReferenceLabel);
refInsertButton?.addEventListener('click', insertReferenceCommand);
refListInsertButton?.addEventListener('click', insertReferenceListCommand);
citeKeySelectEl?.addEventListener('change', () => populateBibliographyFields(citeKeySelectEl.value));
citeInsertButton?.addEventListener('click', insertCitationCommand);
bibAddButton?.addEventListener('click', addBibliographyItem);
bibUpdateButton?.addEventListener('click', updateBibliographyItem);

// ------------------------------------------------------------- document settings

function parseDocumentSettings(source) {
  const docClass = source.match(/\\documentclass(?:\[([^\]]*)\])?\{([^{}]+)\}/);
  const geometryMatch = source.match(/\\usepackage(?:\[([^\]]*)\])?\{geometry\}/);
  const geometryOptions = parseOptionList(geometryMatch?.[1] || '');
  const packages = [...source.matchAll(/\\usepackage(?:\[([^\]]*)\])?\{([^{}]+)\}/g)]
    .flatMap((match) => match[2].split(',').map((name) => ({ name: name.trim(), options: match[1] || '' })))
    .filter((pkg) => pkg.name && pkg.name !== 'geometry')
    .map((pkg) => (pkg.options ? `${pkg.name}[${pkg.options}]` : pkg.name));
  return {
    docClass: docClass?.[2] || 'jlreq',
    docOptions: docClass?.[1] || '',
    paper: geometryOptions.paper || 'a4paper',
    margin: geometryOptions.margin || '',
    title: readPreambleCommand(source, 'title'),
    author: readPreambleCommand(source, 'author'),
    date: readPreambleCommand(source, 'date'),
    maketitle: /\\begin\{document\}[\s\S]*?\\maketitle\b/.test(source),
    packages,
  };
}

function parseOptionList(options) {
  const result = {};
  for (const raw of String(options).split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq >= 0) result[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    else if (/paper$/i.test(part)) result.paper = part;
  }
  return result;
}

function readPreambleCommand(source, command) {
  const begin = source.search(/\\begin\{document\}/);
  const preamble = begin >= 0 ? source.slice(0, begin) : source;
  const re = new RegExp(`\\\\${command}\\{([^{}]*)\\}`);
  return preamble.match(re)?.[1] || '';
}

function renderCustomizeSettings(source) {
  if (!customDocClassEl || customizeDirty) return;
  const settings = parseDocumentSettings(source);
  customDocClassEl.value = [...customDocClassEl.options].some((option) => option.value === settings.docClass)
    ? settings.docClass
    : 'jlreq';
  if (settings.docClass && customDocClassEl.value !== settings.docClass) {
    customDocOptionsEl.value = [settings.docClass, settings.docOptions].filter(Boolean).join(', ');
  } else {
    customDocOptionsEl.value = settings.docOptions;
  }
  customPaperEl.value = [...customPaperEl.options].some((option) => option.value === settings.paper) ? settings.paper : 'a4paper';
  customMarginEl.value = settings.margin;
  customTitleEl.value = settings.title;
  customAuthorEl.value = settings.author;
  customDateEl.value = displayDateSetting(settings.date);
  customMaketitleEl.checked = settings.maketitle;
  customPackagesEl.value = settings.packages.join('\n');
}

function applyCustomizeSettings() {
  let source = editor.value;
  const docClass = customDocClassEl?.value || 'jlreq';
  const docOptions = customDocOptionsEl?.value?.trim() || '';
  const paper = customPaperEl?.value || 'a4paper';
  const margin = customMarginEl?.value?.trim() || '';
  const geometryOptions = [paper, margin ? `margin=${margin}` : ''].filter(Boolean).join(',');
  source = setDocumentClass(source, docClass, docOptions);
  source = setPackageSpec(source, 'geometry', geometryOptions);
  source = setPreambleCommand(source, 'title', customTitleEl?.value?.trim() || '');
  source = setPreambleCommand(source, 'author', customAuthorEl?.value?.trim() || '');
  source = setPreambleCommand(source, 'date', customDateEl?.value?.trim() || '');
  source = setMaketitle(source, !!customMaketitleEl?.checked);
  for (const spec of parsePackageSpecs(customPackagesEl?.value || '')) {
    source = setPackageSpec(source, spec.name, spec.options);
  }
  editor.value = source;
  customizeDirty = false;
  scheduleSync();
  statusEl.textContent = '文書設定を反映しました';
}

function setDocumentClass(source, className, options) {
  const replacement = `\\documentclass${options ? `[${options}]` : ''}{${className}}`;
  const re = /\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}/;
  if (re.test(source)) return source.replace(re, replacement);
  return replacement + '\n' + source;
}

function setPackageSpec(source, packageName, options = '') {
  const cleanName = String(packageName).trim();
  if (!cleanName) return source;
  const escaped = escapeRegExp(cleanName);
  const replacement = `\\usepackage${options ? `[${options}]` : ''}{${cleanName}}`;
  const re = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${escaped}\\}`);
  if (re.test(source)) return source.replace(re, replacement);
  const docClass = source.match(/\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}/);
  if (docClass) {
    const insertAt = docClass.index + docClass[0].length;
    return source.slice(0, insertAt) + `\n${replacement}` + source.slice(insertAt);
  }
  return replacement + '\n' + source;
}

function setPreambleCommand(source, command, value) {
  const begin = source.search(/\\begin\{document\}/);
  const splitAt = begin >= 0 ? begin : source.length;
  let preamble = source.slice(0, splitAt);
  const rest = source.slice(splitAt);
  const re = new RegExp(`\\n?\\\\${command}\\{[^{}]*\\}`, 'g');
  preamble = preamble.replace(re, '');
  if (!value) return preamble.replace(/\n{3,}/g, '\n\n') + rest;
  const line = command === 'date' ? dateCommandLine(value) : `\\${command}{${escapeLatexText(value)}}`;
  return preamble.replace(/\s*$/, '\n') + line + '\n' + rest.replace(/^\n*/, '');
}

function displayDateSetting(value) {
  return String(value || '').trim() === '\\today' ? '今日の日付' : value;
}

function dateCommandLine(value) {
  const clean = String(value || '').trim();
  if (/^(今日|今日の日付|today)$/i.test(clean)) return '\\date{\\today}';
  return `\\date{${escapeLatexText(clean)}}`;
}

function setMaketitle(source, enabled) {
  source = source.replace(/\n?\\maketitle\b\s*/g, '\n');
  if (!enabled) return source.replace(/\n{3,}/g, '\n\n');
  const begin = source.match(/\\begin\{document\}/);
  if (!begin) return source + '\n\\maketitle\n';
  const insertAt = begin.index + begin[0].length;
  return source.slice(0, insertAt) + '\n\\maketitle\n' + source.slice(insertAt).replace(/^\n+/, '');
}

function parsePackageSpecs(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?$/);
      return match ? { name: match[1], options: match[2] || '' } : null;
    })
    .filter(Boolean);
}

function packageSpecName(spec) {
  return String(spec || '').replace(/\[[\s\S]*\]$/, '').trim();
}

function addPackagePreset(kind) {
  const specs = PACKAGE_PRESETS[kind] ?? [];
  if (!customPackagesEl || !specs.length) return;
  const existing = customPackagesEl.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const names = new Set(existing.map(packageSpecName));
  const additions = specs.filter((spec) => !names.has(packageSpecName(spec)));
  if (!additions.length) {
    statusEl.textContent = 'この用途のパッケージはすでに入っています';
    return;
  }
  customPackagesEl.value = [...existing, ...additions].join('\n');
  customizeDirty = true;
  statusEl.textContent = '用途別パッケージを追加しました';
}

[
  customDocClassEl,
  customDocOptionsEl,
  customPaperEl,
  customMarginEl,
  customTitleEl,
  customAuthorEl,
  customDateEl,
  customMaketitleEl,
  customPackagesEl,
].forEach((control) => control?.addEventListener('input', () => { customizeDirty = true; }));
packagePresetButtons.forEach((button) => {
  button.addEventListener('click', () => addPackagePreset(button.dataset.packagePreset));
});
customApplyButton?.addEventListener('click', applyCustomizeSettings);

async function saveCurrentTemplate() {
  const name = templateNameEl?.value?.trim() || customTitleEl?.value?.trim() || 'Custom template';
  const desc = templateDescEl?.value?.trim() || '現在の文書設定から作成';
  templateSaveButton.disabled = true;
  try {
    const res = await fetch('/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, desc, source: editor.value }),
    });
    const saved = await res.json();
    if (!res.ok || saved.error) throw new Error(saved.error || `HTTP ${res.status}`);
    await loadTemplateList(saved.id);
    statusEl.textContent = `テンプレート「${saved.name}」を保存しました`;
  } catch (err) {
    statusEl.textContent = `テンプレート保存エラー: ${err.message}`;
  } finally {
    templateSaveButton.disabled = false;
  }
}

templateSaveButton?.addEventListener('click', saveCurrentTemplate);

function insertRegion() {
  const type = regionTypeEl?.value || 'paragraph';
  let source = editor.value;
  if (['theorem', 'lemma', 'definition', 'proof'].includes(type)) source = ensurePackage(source, 'amsthm');
  if (['theorem', 'lemma', 'definition'].includes(type)) source = ensureTheoremEnvironments(source, [type]);
  editor.value = insertTexAtTarget(source, buildRegionTex(), regionTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = '新しい編集領域を追加しました';
  setWorkspaceMode('edit');
}

function insertCodeBlock() {
  const source = ensurePackage(editor.value, 'kkluaverb');
  editor.value = insertTexAtTarget(source, buildCodeTex(), codeTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = 'kkluaverb のコードブロックを追加しました';
  setWorkspaceMode('edit');
}

regionInsertButton?.addEventListener('click', insertRegion);
codeInsertButton?.addEventListener('click', insertCodeBlock);

function texFileKind(name, selected = 'auto') {
  if (selected && selected !== 'auto') return selected;
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  if (['sty', 'tex', 'bib', 'cls'].includes(ext)) return ext;
  return 'tex';
}

function isSupportedTexFile(file) {
  return ['sty', 'tex', 'bib', 'cls'].includes(String(file?.name || '').split('.').pop()?.toLowerCase());
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsText(file);
  });
}

function renderCodeFilePreview(meta, text, error = '') {
  if (codeFilePreviewMetaEl) codeFilePreviewMetaEl.textContent = meta || '未選択';
  if (codeFilePreviewBodyEl) {
    codeFilePreviewBodyEl.textContent = error || text || 'ファイルを選択すると内容を確認できます。';
    codeFilePreviewBodyEl.classList.toggle('has-error', !!error);
  }
}

async function uploadTexFile(name, text) {
  const res = await fetch('/texfiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text }),
  });
  const saved = await res.json();
  if (!res.ok || saved.error) throw new Error(saved.error || `HTTP ${res.status}`);
  await loadUploadedTexFiles();
  return saved;
}

function bibResourceName(texPath) {
  return String(texPath || '').replace(/\.bib$/i, '');
}

function integrateTexFileIntoSource(source, saved, kind, target = 'end') {
  if (kind === 'sty') {
    return ensurePackage(source, saved.packageName);
  }
  if (kind === 'tex') {
    return insertTexAtTarget(source, `\n\\input{${saved.texPath}}\n`, target);
  }
  if (kind === 'bib') {
    return insertTexAtTarget(source, `\n\\bibliographystyle{plain}\n\\bibliography{${bibResourceName(saved.texPath)}}\n`, target);
  }
  return source;
}

function uploadedTexFileByPath(texPath) {
  return uploadedTexFiles.find((file) => file.texPath === texPath || file.packageName === texPath) || null;
}

function setSelectedCodeFile(selection) {
  selectedCodeFile = selection;
  if (codePickedFileEl) {
    codePickedFileEl.textContent = selection?.path || pendingCodeFile?.name || codeFileInputEl?.files?.[0]?.name || '未選択';
  }
  renderCodeFileList(editor.value);
}

function pickLocalCodeFile(file) {
  pendingCodeFile = file || null;
  selectedCodeFile = null;
  if (codePickedFileEl) codePickedFileEl.textContent = file ? file.name : '未選択';
  if (file) {
    readTextFile(file)
      .then((text) => renderCodeFilePreview(`${file.name} / ${file.size} bytes`, text))
      .catch((err) => renderCodeFilePreview(file.name, '', `ファイルを読み込めませんでした: ${err.message}`));
  } else {
    renderCodeFilePreview('', '');
  }
  renderCodeFileList(editor.value);
}

async function previewUploadedCodeFile(selection) {
  if (!selection?.uploaded) {
    renderCodeFilePreview(selection?.path || '', '', '');
    return;
  }
  renderCodeFilePreview(selection.path, '読み込み中…');
  try {
    const res = await fetch(`/texfiles/${encodeURIComponent(selection.path)}`);
    const payload = await res.json();
    if (!res.ok || payload.error) throw new Error(payload.error || `HTTP ${res.status}`);
    renderCodeFilePreview(`${payload.texPath} / ${payload.size} bytes`, payload.text || '');
  } catch (err) {
    renderCodeFilePreview(selection.path, '', `ファイルを読み込めませんでした: ${err.message}`);
  }
}

async function integrateSelectedCodeFile() {
  const file = pendingCodeFile || codeFileInputEl?.files?.[0];
  const selectedUploaded = selectedCodeFile?.uploaded ? uploadedTexFileByPath(selectedCodeFile.path) : null;
  if (!file) {
    if (!selectedUploaded) {
      statusEl.textContent = '組み込む TeX 系ファイルを選択してください';
      return;
    }
  }
  codeFileIntegrateButton.disabled = true;
  try {
    const kind = texFileKind(file?.name || selectedUploaded.texPath, codeFileKindEl?.value || selectedCodeFile?.kind || 'auto');
    const saved = file ? await uploadTexFile(file.name, await readTextFile(file)) : selectedUploaded;
    editor.value = integrateTexFileIntoSource(editor.value, saved, kind, codeFileTargetEl?.value || 'end');
    scheduleSync();
    statusEl.textContent =
      kind === 'cls'
        ? `${saved.texPath} を保存しました。文書クラスの切り替えはカスタマイズで行います`
        : `${saved.texPath} を文書に組み込みました`;
    selectedCodeFile = null;
    pendingCodeFile = null;
    if (codeFileInputEl) codeFileInputEl.value = '';
    if (codePickedFileEl) codePickedFileEl.textContent = '未選択';
    renderCodeFileList(editor.value);
  } catch (err) {
    statusEl.textContent = `ファイル組み込みエラー: ${err.message}`;
  } finally {
    codeFileIntegrateButton.disabled = false;
  }
}

function splitFileBody(title, body) {
  const heading = title ? `\\section{${escapeLatexText(title)}}\n\\label{sec:${slugifyLabel(title)}}\n\n` : '';
  return `${heading}${escapeLatexText(body || '')}`.replace(/\s*$/, '\n');
}

async function createSplitTexFile() {
  const title = codeSplitTitleEl?.value?.trim() || '新しい章';
  const name = codeSplitNameEl?.value?.trim() || `chapters/${slugifyLabel(title)}.tex`;
  const command = codeSplitCommandEl?.value === 'include' ? 'include' : 'input';
  codeSplitCreateButton.disabled = true;
  try {
    const saved = await uploadTexFile(name, splitFileBody(title, codeSplitBodyEl?.value || ''));
    const refPath = command === 'include' ? saved.texPath.replace(/\.tex$/i, '') : saved.texPath;
    editor.value = insertTexAtTarget(editor.value, `\n\\${command}{${refPath}}\n`, codeSplitTargetEl?.value || 'end');
    scheduleSync();
    statusEl.textContent = `${saved.texPath} を作成し、\\${command} 参照を追加しました`;
    renderCodeFileList(editor.value);
  } catch (err) {
    statusEl.textContent = `分割ファイル作成エラー: ${err.message}`;
  } finally {
    codeSplitCreateButton.disabled = false;
  }
}

codeFileIntegrateButton?.addEventListener('click', integrateSelectedCodeFile);
codeSplitCreateButton?.addEventListener('click', createSplitTexFile);
codeFilePickButton?.addEventListener('click', () => codeFileInputEl?.click());
codeFileInputEl?.addEventListener('change', () => {
  pickLocalCodeFile(codeFileInputEl.files?.[0] || null);
});
codeFileListEl?.addEventListener('click', (ev) => {
  const item = ev.target.closest?.('[data-code-file-path]');
  if (!item || !codePickedFileEl) return;
  const path = item.dataset.codeFilePath || '';
  const uploaded = item.dataset.codeFileUploaded === 'true';
  pendingCodeFile = null;
  setSelectedCodeFile({ path, uploaded, kind: item.dataset.codeFileKind || 'auto' });
  if (uploaded && codeFileInputEl) codeFileInputEl.value = '';
  previewUploadedCodeFile(selectedCodeFile);
});

document.querySelector('.code-sidebar')?.addEventListener('dragover', (ev) => {
  if (![...ev.dataTransfer?.items || []].some((item) => item.kind === 'file')) return;
  ev.preventDefault();
  ev.currentTarget.classList.add('is-dropping');
});
document.querySelector('.code-sidebar')?.addEventListener('dragleave', (ev) => {
  if (ev.relatedTarget && ev.currentTarget.contains(ev.relatedTarget)) return;
  ev.currentTarget.classList.remove('is-dropping');
});
document.querySelector('.code-sidebar')?.addEventListener('drop', (ev) => {
  ev.preventDefault();
  ev.currentTarget.classList.remove('is-dropping');
  const file = [...ev.dataTransfer?.files || []].find(isSupportedTexFile);
  if (!file) {
    statusEl.textContent = '.tex/.sty/.cls/.bib ファイルをドロップしてください';
    return;
  }
  if (codeFileInputEl) codeFileInputEl.value = '';
  pickLocalCodeFile(file);
  statusEl.textContent = `${file.name} を選択しました`;
});

async function insertImageFigure() {
  const file = imageFileEl?.files?.[0];
  if (!file) {
    statusEl.textContent = '画像ファイルを選択してください';
    return;
  }
  imageInsertButton.disabled = true;
  try {
    const asset = await uploadImageAsset(file);
    const source = ensurePackage(editor.value, 'graphicx');
    editor.value = insertTexAtTarget(source, buildImageFigureTex(asset), imageTargetEl?.value || 'end');
    scheduleSync();
    statusEl.textContent = `画像 ${asset.filename} を図として追加しました`;
    setWorkspaceMode('edit');
  } catch (err) {
    statusEl.textContent = `画像追加エラー: ${err.message}`;
  } finally {
    imageInsertButton.disabled = false;
  }
}

imageInsertButton?.addEventListener('click', insertImageFigure);

// ---------------------------------------------------------------- table builder

function normalizeTableSize(rows, cols) {
  const next = [];
  for (let r = 0; r < rows; r++) {
    const row = tableData[r] ? [...tableData[r]] : [];
    while (row.length < cols) row.push('');
    next.push(row.slice(0, cols));
  }
  tableData = next;
  for (const key of [...tableMerges.keys()]) {
    const merge = tableMerges.get(key);
    if (!merge || merge.row >= rows || merge.col >= cols) tableMerges.delete(key);
    else {
      merge.rowspan = Math.min(merge.rowspan, rows - merge.row);
      merge.colspan = Math.min(merge.colspan, cols - merge.col);
      if (merge.rowspan <= 1 && merge.colspan <= 1) tableMerges.delete(key);
    }
  }
}

function readTableGrid() {
  if (!tableGridEl) return;
  tableGridEl.querySelectorAll('[data-table-cell]').forEach((input) => {
    const r = Number(input.dataset.row);
    const c = Number(input.dataset.col);
    if (!tableData[r]) tableData[r] = [];
    tableData[r][c] = input.value;
  });
}

function renderTableGrid() {
  if (!tableGridEl || !tableRowsEl || !tableColsEl) return;
  const rows = Math.max(1, Math.min(20, Number(tableRowsEl.value || tableData.length || 1)));
  const cols = Math.max(1, Math.min(12, Number(tableColsEl.value || tableData[0]?.length || 1)));
  tableRowsEl.value = String(rows);
  tableColsEl.value = String(cols);
  normalizeTableSize(rows, cols);
  tableGridEl.style.setProperty('--table-cols', String(cols));
  tableGridEl.textContent = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isCoveredTableCell(r, c)) {
        const hidden = document.createElement('div');
        hidden.className = 'table-cell-hidden';
        hidden.textContent = '結合';
        tableGridEl.appendChild(hidden);
        continue;
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.tableCell = 'true';
      input.dataset.row = String(r);
      input.dataset.col = String(c);
      input.classList.toggle('is-selected', selectedTableCell.row === r && selectedTableCell.col === c);
      const merge = tableMerges.get(tableCellKey(r, c));
      if (merge) input.title = `結合: ${merge.rowspan}行 x ${merge.colspan}列`;
      input.value = tableData[r][c] ?? '';
      input.placeholder = r === 0 ? `見出し ${c + 1}` : `R${r + 1}C${c + 1}`;
      input.addEventListener('focus', () => selectTableCell(r, c));
      input.addEventListener('click', () => selectTableCell(r, c));
      input.addEventListener('input', readTableGrid);
      tableGridEl.appendChild(input);
    }
  }
  renderTableSelection();
}

function tableCellKey(row, col) {
  return `${row}:${col}`;
}

function isCoveredTableCell(row, col) {
  for (const merge of tableMerges.values()) {
    if (row === merge.row && col === merge.col) continue;
    if (row >= merge.row && row < merge.row + merge.rowspan && col >= merge.col && col < merge.col + merge.colspan) return true;
  }
  return false;
}

function selectTableCell(row, col) {
  selectedTableCell = { row, col };
  const merge = tableMerges.get(tableCellKey(row, col));
  if (tableRowspanEl) tableRowspanEl.value = String(merge?.rowspan ?? 1);
  if (tableColspanEl) tableColspanEl.value = String(merge?.colspan ?? 1);
  renderTableSelection();
  tableGridEl?.querySelectorAll('[data-table-cell]').forEach((input) => {
    input.classList.toggle('is-selected', Number(input.dataset.row) === row && Number(input.dataset.col) === col);
  });
}

function renderTableSelection() {
  if (!tableSelectionEl) return;
  const merge = tableMerges.get(tableCellKey(selectedTableCell.row, selectedTableCell.col));
  tableSelectionEl.textContent = `選択: R${selectedTableCell.row + 1}C${selectedTableCell.col + 1}${merge ? ` / ${merge.rowspan}行 x ${merge.colspan}列` : ''}`;
}

function resizeTableFromInputs() {
  readTableGrid();
  renderTableGrid();
}

function addTableRow() {
  readTableGrid();
  tableRowsEl.value = String(Math.min(20, Number(tableRowsEl.value || tableData.length) + 1));
  renderTableGrid();
}

function addTableCol() {
  readTableGrid();
  tableColsEl.value = String(Math.min(12, Number(tableColsEl.value || tableData[0]?.length || 1) + 1));
  renderTableGrid();
}

function deleteTableRow() {
  readTableGrid();
  if (tableData.length <= 1) return;
  tableData.pop();
  for (const key of [...tableMerges.keys()]) if (tableMerges.get(key).row >= tableData.length) tableMerges.delete(key);
  tableRowsEl.value = String(tableData.length);
  renderTableGrid();
}

function deleteTableCol() {
  readTableGrid();
  const cols = tableData[0]?.length ?? 1;
  if (cols <= 1) return;
  tableData = tableData.map((row) => row.slice(0, cols - 1));
  for (const key of [...tableMerges.keys()]) if (tableMerges.get(key).col >= cols - 1) tableMerges.delete(key);
  tableColsEl.value = String(cols - 1);
  renderTableGrid();
}

function parsePastedTable(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line));
  const rows = lines.map((line) => {
    if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim());
    if (line.includes('|')) return line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    return line.split(',').map((cell) => cell.trim());
  }).filter((row) => row.length);
  const width = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
}

function importPastedTable() {
  const rows = parsePastedTable(tablePasteEl?.value || '');
  if (!rows.length) return;
  tableData = rows.slice(0, 20).map((row) => row.slice(0, 12));
  tableMerges.clear();
  selectedTableCell = { row: 0, col: 0 };
  tableRowsEl.value = String(tableData.length);
  tableColsEl.value = String(tableData[0]?.length || 1);
  renderTableGrid();
  statusEl.textContent = '貼り付けデータから表を作成しました';
}

function applyTableMerge() {
  readTableGrid();
  const rows = tableData.length;
  const cols = tableData[0]?.length ?? 1;
  const row = selectedTableCell.row;
  const col = selectedTableCell.col;
  const rowspan = Math.max(1, Math.min(rows - row, Number(tableRowspanEl?.value || 1)));
  const colspan = Math.max(1, Math.min(cols - col, Number(tableColspanEl?.value || 1)));
  const key = tableCellKey(row, col);
  if (rowspan === 1 && colspan === 1) tableMerges.delete(key);
  else tableMerges.set(key, { row, col, rowspan, colspan });
  renderTableGrid();
}

function clearTableMerge() {
  tableMerges.delete(tableCellKey(selectedTableCell.row, selectedTableCell.col));
  if (tableRowspanEl) tableRowspanEl.value = '1';
  if (tableColspanEl) tableColspanEl.value = '1';
  renderTableGrid();
}

function tableColumnSpec(cols) {
  const custom = tableColspecEl?.value?.trim();
  if (custom) {
    const parts = custom.split(/[\s,]+/).filter(Boolean).slice(0, cols);
    while (parts.length < cols) parts.push(tableAlignEl?.value || 'c');
    return parts.map(normalizeTableColumnToken).join('');
  }
  const align = tableAlignEl?.value || 'c';
  if (align === 'X') return Array(cols).fill('X').join('');
  return Array(cols).fill(align).join('');
}

function normalizeTableColumnToken(token) {
  if (/^Q\[[^\]]+\]$/.test(token)) return token;
  if (/^X(?:\[[^\]]+\])?$/.test(token)) return token;
  if (['l', 'c', 'r'].includes(token)) return token;
  return 'c';
}

function tableStyleOptions(style) {
  if (style === 'striped') {
    return [
      'hlines',
      'vlines',
      'row{1}={bg=azure3,fg=white,font=\\bfseries}',
      'row{odd}={azure9}',
      'row{even}={white}',
    ];
  }
  if (style === 'compact') {
    return [
      'rowsep=1pt',
      'colsep=4pt',
      'hlines',
      'row{1}={font=\\bfseries}',
    ];
  }
  if (style === 'academic') {
    return [
      'hline{1,Z}={1pt}',
      'hline{2}={0.6pt}',
      'row{1}={font=\\bfseries}',
    ];
  }
  return [];
}

function buildTabularrayTable() {
  readTableGrid();
  const rows = tableData.length;
  const cols = tableData[0]?.length ?? 1;
  const style = tableStyleEl?.value || 'academic';
  const options = [`colspec={${tableColumnSpec(cols)}}`, ...tableStyleOptions(style)];
  if (tableLinesEl?.checked && style === 'plain') options.push('hlines', 'vlines');
  if (tableHeaderEl?.checked && !options.some((option) => option.startsWith('row{1}='))) {
    options.push('row{1}={font=\\bfseries}');
  }
  const caption = tableCaptionEl?.value?.trim() || '作成した表';
  const label = `tab:${slugifyLabel(caption)}`;
  const body = tableData
    .map((row, r) => `  ${row.map((cell, c) => tableCellTex(r, c, cell)).join(' & ')} \\\\`)
    .join('\n');
  return [
    '',
    '\\begin{table}[t]',
    '\\centering',
    `\\begin{tblr}{${options.join(',')}}`,
    body,
    '\\end{tblr}',
    `\\caption{${escapeLatexText(caption)}}`,
    `\\label{${label}}`,
    '\\end{table}',
  ].join('\n') + '\n';
}

function tableCellTex(row, col, cell) {
  if (isCoveredTableCell(row, col)) return '';
  const merge = tableMerges.get(tableCellKey(row, col));
  const text = escapeLatexText(cell || '');
  if (!merge) return text;
  const options = [];
  if (merge.rowspan > 1) options.push(`r=${merge.rowspan}`);
  if (merge.colspan > 1) options.push(`c=${merge.colspan}`);
  return `\\SetCell[${options.join(',')}]{} ${text}`;
}

function insertTable() {
  const source = ensurePackage(editor.value, 'tabularray');
  editor.value = insertTexAtTarget(source, buildTabularrayTable(), tableTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = 'tabularray の表を追加しました';
  setWorkspaceMode('edit');
}

tableResizeButton?.addEventListener('click', resizeTableFromInputs);
tableAddRowButton?.addEventListener('click', addTableRow);
tableAddColButton?.addEventListener('click', addTableCol);
tableDelRowButton?.addEventListener('click', deleteTableRow);
tableDelColButton?.addEventListener('click', deleteTableCol);
tableImportButton?.addEventListener('click', importPastedTable);
tableMergeApplyButton?.addEventListener('click', applyTableMerge);
tableMergeClearButton?.addEventListener('click', clearTableMerge);
tableInsertButton?.addEventListener('click', insertTable);
renderTableGrid();

// ---------------------------------------------------------------- drawing tool

const DRAW_TOOLSETS = {
  '2d': [
    { id: 'line', label: '線', family: 'path' },
    { id: 'arrow', label: '矢印', family: 'path' },
    { id: 'polyline', label: '折れ線', family: 'path' },
    { id: 'rect', label: '四角', family: 'shape' },
    { id: 'circle', label: '円', family: 'shape' },
    { id: 'ellipse', label: '楕円', family: 'shape' },
    { id: 'arc', label: '円弧', family: 'path' },
    { id: 'bezier', label: '曲線', family: 'path' },
    { id: 'grid', label: 'グリッド', family: 'guide' },
    { id: 'axes', label: '座標軸', family: 'guide' },
    { id: 'node', label: 'ノード', family: 'node' },
    { id: 'label', label: 'ラベル', family: 'node' },
    { id: 'fill', label: '塗り', family: 'style' },
    { id: 'pattern', label: 'パターン', family: 'style' },
    { id: 'background', label: '背景レイヤー', family: 'layer' },
    { id: 'double-line', label: '二重線', family: 'path' },
    { id: 'clip-fill', label: '交差塗り', family: 'scope' },
    { id: 'dimension', label: '寸法線', family: 'annotation' },
    { id: 'angle', label: '角度記号', family: 'annotation' },
    { id: 'brace', label: 'ブレース', family: 'annotation' },
    { id: 'snake', label: '波線', family: 'decoration' },
    { id: 'intersection', label: '交点', family: 'calc' },
    { id: 'fit', label: '囲み', family: 'node' },
    { id: 'callout', label: '吹き出し', family: 'node' },
    { id: 'foreach', label: '反復配置', family: 'advanced' },
    { id: 'clip', label: 'クリップ', family: 'scope' },
    { id: 'scope', label: 'スコープ', family: 'scope' },
    { id: 'custom', label: 'TikZ部品', family: 'advanced' },
  ],
  '3d': [
    { id: 'axis3d', label: '3D座標軸', family: '3d' },
    { id: 'cube', label: '立方体', family: '3d' },
    { id: 'plane3d', label: '平面', family: '3d' },
    { id: 'vector3d', label: '3Dベクトル', family: '3d' },
    { id: 'surface', label: '曲面', family: '3d' },
    { id: 'sphere', label: '球', family: '3d' },
    { id: 'cylinder', label: '円柱', family: '3d' },
    { id: 'cone', label: '円錐', family: '3d' },
    { id: 'torus', label: 'トーラス', family: '3d' },
    { id: 'projection', label: '射影', family: '3d' },
    { id: 'rotate3d', label: '回転', family: 'transform' },
    { id: 'custom3d', label: '3D TikZ部品', family: 'advanced' },
  ],
  graph: [
    { id: 'function', label: '関数 y=f(x)', family: 'plot' },
    { id: 'parametric', label: '媒介変数', family: 'plot' },
    { id: 'scatter', label: '散布図', family: 'plot' },
    { id: 'bar', label: '棒グラフ', family: 'plot' },
    { id: 'area', label: '面グラフ', family: 'plot' },
    { id: 'polar', label: '極座標', family: 'plot' },
    { id: 'histogram', label: 'ヒストグラム', family: 'plot' },
    { id: 'axis-plot', label: '軸付きプロット', family: 'pgfplots' },
    { id: 'multi-plot', label: '複数系列', family: 'pgfplots' },
    { id: 'error-bars', label: '誤差棒', family: 'pgfplots' },
    { id: 'heatmap', label: 'ヒートマップ', family: 'pgfplots' },
    { id: 'graph-nodes', label: 'ノードグラフ', family: 'graph' },
    { id: 'flowchart', label: 'フローチャート', family: 'graph' },
    { id: 'tree', label: '木構造', family: 'graph' },
    { id: 'mindmap', label: 'マインドマップ', family: 'graph' },
    { id: 'automaton', label: '状態遷移', family: 'graph' },
    { id: 'commutative', label: '可換図式', family: 'graph' },
    { id: 'custom-plot', label: 'pgfplots/TikZ', family: 'advanced' },
  ],
};

function renderDrawing() {
  if (!drawSvgEl || !drawItemsEl) return;
  renderDrawPalette();
  drawSvgEl.textContent = '';
  for (const item of drawItems) {
    if (item.type === 'line') {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'draw-shape');
      applyPreviewStyle(line, item);
      bindDrawSvgElement(line, item);
      line.setAttribute('x1', item.x1);
      line.setAttribute('y1', item.y1);
      line.setAttribute('x2', item.x2);
      line.setAttribute('y2', item.y2);
      drawSvgEl.appendChild(line);
    } else if (item.type === 'rect') {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'draw-shape');
      applyPreviewStyle(rect, item);
      bindDrawSvgElement(rect, item);
      rect.setAttribute('x', item.x);
      rect.setAttribute('y', item.y);
      rect.setAttribute('width', item.w);
      rect.setAttribute('height', item.h);
      drawSvgEl.appendChild(rect);
    } else if (item.type === 'circle') {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'draw-shape');
      applyPreviewStyle(circle, item);
      bindDrawSvgElement(circle, item);
      circle.setAttribute('cx', item.cx);
      circle.setAttribute('cy', item.cy);
      circle.setAttribute('r', item.r);
      drawSvgEl.appendChild(circle);
    } else if (item.type === 'ellipse') {
      const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      ellipse.setAttribute('class', 'draw-shape');
      applyPreviewStyle(ellipse, item);
      bindDrawSvgElement(ellipse, item);
      ellipse.setAttribute('cx', item.cx);
      ellipse.setAttribute('cy', item.cy);
      ellipse.setAttribute('rx', item.rx);
      ellipse.setAttribute('ry', item.ry);
      drawSvgEl.appendChild(ellipse);
    } else if (item.type === 'label') {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'draw-label');
      bindDrawSvgElement(text, item);
      text.setAttribute('fill', previewColor(item.color ?? 'black'));
      text.setAttribute('x', item.x);
      text.setAttribute('y', item.y);
      text.textContent = item.text;
      drawSvgEl.appendChild(text);
    } else if (item.type === 'arrow' || item.type === 'vector3d') {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'draw-shape');
      applyPreviewStyle(line, item);
      bindDrawSvgElement(line, item);
      line.setAttribute('x1', item.x1);
      line.setAttribute('y1', item.y1);
      line.setAttribute('x2', item.x2);
      line.setAttribute('y2', item.y2);
      line.setAttribute('marker-end', 'url(#draw-arrow)');
      ensureDrawArrowMarker();
      drawSvgEl.appendChild(line);
    } else if (item.type === 'polyline') {
      drawPreviewPolyline(item);
    } else if (item.type === 'axes' || item.type === 'axis3d') {
      drawPreviewAxes(item);
    } else if (item.type === 'grid') {
      drawPreviewGrid(item);
    } else if (item.type === 'cube') {
      drawPreviewCube(item);
    } else if (item.type === 'function' || item.type === 'parametric' || item.type === 'polar' || item.type === 'axis-plot' || item.type === 'multi-plot') {
      drawPreviewPlot(item);
    } else if (item.type === 'bar' || item.type === 'histogram' || item.type === 'error-bars' || item.type === 'heatmap') {
      drawPreviewBars(item);
    } else if (item.type === 'graph-nodes' || item.type === 'flowchart' || item.type === 'tree' || item.type === 'mindmap' || item.type === 'automaton' || item.type === 'commutative') {
      drawPreviewGraph(item);
    } else if (item.type === 'dimension' || item.type === 'brace' || item.type === 'snake' || item.type === 'double-line') {
      drawPreviewAnnotation(item);
    } else if (item.type === 'background' || item.type === 'clip-fill') {
      drawPreviewLayerFeature(item);
    } else {
      drawPreviewBadge(item);
    }
  }
  renderDrawHandles();
  drawItemsEl.textContent = '';
  if (!drawItems.length) {
    drawItemsEl.innerHTML = '<div class="empty-state">キャンバスをクリックして図形を追加</div>';
  } else {
    for (const item of drawItems) {
      const row = document.createElement('div');
      row.className = 'draw-item';
      row.classList.toggle('is-selected', item.id === selectedDrawId);
      row.innerHTML = `<span>${escapeHtml(drawItemLabel(item))}</span>`;
      row.addEventListener('click', () => {
        selectedDrawId = item.id;
        renderDrawing();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '削除';
      remove.addEventListener('click', (ev) => {
        ev.stopPropagation();
        drawItems = drawItems.filter((entry) => entry.id !== item.id);
        if (selectedDrawId === item.id) selectedDrawId = drawItems[0]?.id ?? null;
        renderDrawing();
      });
      row.appendChild(remove);
      drawItemsEl.appendChild(row);
    }
  }
  if (drawInsertButton) drawInsertButton.disabled = drawItems.length === 0;
  const hasSelection = drawItems.some((entry) => entry.id === selectedDrawId);
  [drawDuplicateButton, drawBackButton, drawFrontButton, drawDeleteButton].forEach((button) => {
    if (button) button.disabled = !hasSelection;
  });
  if (drawUndoButton) drawUndoButton.disabled = drawUndoStack.length === 0;
  if (drawRedoButton) drawRedoButton.disabled = drawRedoStack.length === 0;
  renderDrawProperties();
}

function applyPreviewStyle(el, item) {
  el.classList.toggle('is-selected', item.id === selectedDrawId);
  el.setAttribute('stroke', previewColor(item.color ?? '#1f6f8f'));
  el.setAttribute('stroke-width', item.weight ?? 2);
  if (item.dash === 'dashed') el.setAttribute('stroke-dasharray', '7 5');
  if (item.dash === 'dotted') el.setAttribute('stroke-dasharray', '2 5');
  if (item.fill && item.fill !== 'none') el.setAttribute('fill', previewColor(item.fill));
  if (item.opacity != null) el.setAttribute('opacity', String(Math.max(0.1, Math.min(1, item.opacity / 100))));
}

function bindDrawSvgElement(el, item) {
  el.dataset.drawId = String(item.id);
  el.classList.toggle('is-selected', item.id === selectedDrawId);
  el.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    pushDrawHistory();
    selectedDrawId = item.id;
    drawDragState = { id: item.id, last: svgPointFromEvent(ev), moved: false };
    renderDrawing();
  });
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectedDrawId = item.id;
    renderDrawing();
  });
}

function renderDrawHandles() {
  const item = drawItems.find((entry) => entry.id === selectedDrawId);
  if (!item) return;
  for (const handle of drawHandlesForItem(item)) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'draw-handle');
    dot.setAttribute('cx', handle.x);
    dot.setAttribute('cy', handle.y);
    dot.setAttribute('r', handle.r ?? 5);
    dot.dataset.handle = handle.id;
    dot.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      pushDrawHistory();
      selectedDrawId = item.id;
      drawDragState = { id: item.id, handle: handle.id, last: svgPointFromEvent(ev), moved: false };
    });
    drawSvgEl.appendChild(dot);
  }
}

function drawHandlesForItem(item) {
  if ('x1' in item) {
    return [
      { id: 'start', x: item.x1, y: item.y1 },
      { id: 'end', x: item.x2, y: item.y2 },
    ];
  }
  if (item.type === 'rect') {
    return [
      { id: 'nw', x: item.x, y: item.y },
      { id: 'se', x: item.x + item.w, y: item.y + item.h },
    ];
  }
  if (item.type === 'circle') return [{ id: 'radius', x: item.cx + item.r, y: item.cy }];
  if (item.type === 'ellipse') {
    return [
      { id: 'rx', x: item.cx + item.rx, y: item.cy },
      { id: 'ry', x: item.cx, y: item.cy + item.ry },
    ];
  }
  if ('x' in item && 'y' in item) return [{ id: 'origin', x: item.x, y: item.y, r: 4 }];
  return [];
}

function previewColor(value) {
  if (!value) return '#1f6f8f';
  if (value.startsWith('#')) return value;
  if (value.startsWith('red')) return '#dc2626';
  if (value.startsWith('green')) return '#16a34a';
  if (value.startsWith('purple')) return '#7c3aed';
  if (value.startsWith('orange')) return '#ea580c';
  if (value.startsWith('black')) return '#151923';
  if (value.startsWith('gray')) return '#64748b';
  return '#1f6f8f';
}

function defaultDrawExpression(type) {
  if (type === 'function') return '0.4*\\x*\\x';
  if (type === 'area') return 'sin(\\x*60)+1.4';
  if (type === 'parametric') return '({cos(\\t)},{sin(2*\\t)})';
  if (type === 'polar') return '(1+0.4*cos(3*\\t))';
  if (type === 'scatter') return '0.4/0.8,1/1.3,1.8/1.1,2.4/2,3/1.7';
  if (type === 'bar' || type === 'histogram') return '0.5/1,1.2/1.8,1.9/1.3,2.6/2.2';
  if (type === 'axis-plot') return 'x^2';
  if (type === 'multi-plot') return 'x; x^2; sqrt(x)';
  if (type === 'error-bars') return '0 1 0.1; 1 1.7 0.2; 2 1.3 0.15; 3 2.1 0.25';
  if (type === 'heatmap') return '0 0 1; 0 1 2; 1 0 2; 1 1 4';
  if (type === 'surface') return 'sin(\\x*60)/3';
  return '';
}

function defaultDomainTo(type) {
  if (['function', 'area', 'axis-plot', 'multi-plot'].includes(type)) return 3.6;
  return 360;
}

function isDraw3dType(type) {
  return ['axis3d', 'cube', 'plane3d', 'vector3d', 'surface', 'sphere', 'cylinder', 'cone', 'torus', 'projection', 'rotate3d', 'custom3d'].includes(type);
}

function renderDrawProperties() {
  if (!drawPropsEl) return;
  const item = drawItems.find((entry) => entry.id === selectedDrawId) ?? drawItems[0] ?? null;
  if (!item) {
    drawPropsEl.innerHTML = '<div class="empty-state">図形を選択するとプロパティを編集できます</div>';
    return;
  }
  selectedDrawId = item.id;
  drawPropsEl.innerHTML = `
    <h3>${escapeHtml(drawItemLabel(item))}</h3>
    <div class="draw-prop-grid">
      ${propSelect('color', '線色', item.color ?? 'blue!70!black', DRAW_COLOR_OPTIONS)}
      ${propInput('weight', '太さ', item.weight ?? 2, 'number')}
      ${propSelect('dash', '線種', item.dash ?? 'solid', [['solid', '実線'], ['dashed', '破線'], ['dotted', '点線']])}
      ${propSelect('fill', '塗り', item.fill ?? 'none', DRAW_FILL_OPTIONS)}
      ${propInput('opacity', '透明度', item.opacity ?? 100, 'number')}
      ${propInput('rotate', '回転', item.rotate ?? 0, 'number')}
      ${propInput('scale', '倍率', item.scale ?? 1, 'number')}
      ${coordinateInputsForItem(item)}
      ${advancedInputsForItem(item)}
    </div>
  `;
  drawPropsEl.querySelectorAll('[data-prop]').forEach((control) => {
    control.addEventListener('focus', () => {
      if (control.dataset.historyOpen === 'true') return;
      pushDrawHistory();
      control.dataset.historyOpen = 'true';
    });
    control.addEventListener('blur', () => {
      control.dataset.historyOpen = 'false';
    });
    control.addEventListener('input', () => {
      const prop = control.dataset.prop;
      const numeric = control.type === 'number';
      item[prop] = numeric ? Number(control.value) : control.value;
      renderDrawing();
    });
  });
}

const DRAW_COLOR_OPTIONS = [
  ['blue!70!black', '青'],
  ['black', '黒'],
  ['red!75!black', '赤'],
  ['green!55!black', '緑'],
  ['purple', '紫'],
  ['orange!80!black', '橙'],
  ['gray', '灰'],
];

const DRAW_FILL_OPTIONS = [
  ['none', 'なし'],
  ['blue!10', '淡い青'],
  ['red!10', '淡い赤'],
  ['green!10', '淡い緑'],
  ['yellow!20', '淡い黄'],
  ['gray!15', '淡い灰'],
];

const DRAW_ARROW_OPTIONS = [
  ['Stealth', '標準'],
  ['Latex', 'LaTeX'],
  ['Triangle', '三角'],
  ['Circle', '丸'],
  ['Bar', 'バー'],
];

const DRAW_NODE_SHAPE_OPTIONS = [
  ['rectangle', '四角'],
  ['circle', '円'],
  ['ellipse', '楕円'],
  ['diamond', 'ひし形'],
  ['rounded rectangle', '角丸'],
];

const DRAW_PATTERN_OPTIONS = [
  ['north east lines', '右上斜線'],
  ['north west lines', '左上斜線'],
  ['horizontal lines', '横線'],
  ['vertical lines', '縦線'],
  ['grid', '格子'],
  ['dots', '点'],
];

function propInput(prop, label, value, type = 'text') {
  return `<label>${escapeHtml(label)}<input data-prop="${prop}" type="${type}" value="${escapeHtml(String(value))}"></label>`;
}

function propSelect(prop, label, value, options) {
  return `<label>${escapeHtml(label)}<select data-prop="${prop}">${options
    .map(([id, text]) => `<option value="${id}"${id === value ? ' selected' : ''}>${escapeHtml(text)}</option>`)
    .join('')}</select></label>`;
}

function coordinateInputsForItem(item) {
  if ('x1' in item) return ['x1', 'y1', 'x2', 'y2'].map((p) => propInput(p, p, item[p], 'number')).join('');
  if ('x' in item && 'y' in item && 'w' in item) return ['x', 'y', 'w', 'h'].map((p) => propInput(p, p, item[p], 'number')).join('');
  if ('cx' in item && 'rx' in item) return ['cx', 'cy', 'rx', 'ry'].map((p) => propInput(p, p, item[p], 'number')).join('');
  if ('cx' in item) return ['cx', 'cy', 'r'].map((p) => propInput(p, p, item[p], 'number')).join('');
  if ('x' in item && 'y' in item) return ['x', 'y'].map((p) => propInput(p, p, item[p], 'number')).join('');
  return '';
}

function advancedInputsForItem(item) {
  const parts = [];
  if (item.type === 'arrow' || item.type === 'vector3d') {
    parts.push(propSelect('arrowTip', '矢印', item.arrowTip ?? 'Stealth', DRAW_ARROW_OPTIONS));
  }
  if (item.type === 'rect') {
    parts.push(propInput('rounded', '角丸', item.rounded ?? 0, 'number'));
  }
  if (item.type === 'label' || item.type === 'node') {
    parts.push(propInput('text', 'テキスト', item.text ?? '', 'text'));
    parts.push(propSelect('nodeShape', '形状', item.nodeShape ?? 'rectangle', DRAW_NODE_SHAPE_OPTIONS));
  }
  if (item.type === 'pattern') {
    parts.push(propSelect('patternType', 'パターン', item.patternType ?? 'north east lines', DRAW_PATTERN_OPTIONS));
  }
  if (item.type === 'background') {
    parts.push(propInput('layerText', '背景ラベル', item.layerText ?? 'background', 'text'));
  }
  if (['function', 'parametric', 'polar', 'scatter', 'bar', 'histogram', 'surface', 'area', 'axis-plot', 'multi-plot', 'error-bars', 'heatmap'].includes(item.type)) {
    parts.push(`<label>式・データ<textarea data-prop="expression">${escapeHtml(item.expression ?? '')}</textarea></label>`);
  }
  if (['polyline', 'bezier', 'graph-nodes'].includes(item.type)) {
    parts.push(`<label>点列<textarea data-prop="points">${escapeHtml(item.points ?? '')}</textarea></label>`);
  }
  if (['custom', 'custom3d', 'custom-plot'].includes(item.type)) {
    parts.push(`<label>TikZ本体<textarea data-prop="customBody">${escapeHtml(item.customBody ?? '')}</textarea></label>`);
  }
  parts.push(propInput('customOptions', '追加TikZオプション', item.customOptions ?? '', 'text'));
  if (['function', 'parametric', 'polar', 'area', 'axis-plot', 'multi-plot'].includes(item.type)) {
    parts.push(propInput('domainFrom', '範囲開始', item.domainFrom ?? 0, 'number'));
    parts.push(propInput('domainTo', '範囲終了', item.domainTo ?? defaultDomainTo(item.type), 'number'));
  }
  if (['axis-plot', 'multi-plot', 'error-bars', 'heatmap'].includes(item.type)) {
    parts.push(propInput('xLabel', 'x軸ラベル', item.xLabel ?? 'x', 'text'));
    parts.push(propInput('yLabel', 'y軸ラベル', item.yLabel ?? 'y', 'text'));
    parts.push(propInput('legend', '凡例', item.legend ?? '', 'text'));
    parts.push(propInput('axisOptions', 'axisオプション', item.axisOptions ?? '', 'text'));
  }
  if (isDraw3dType(item.type)) {
    parts.push(propInput('view', '3D視点', item.view ?? '', 'text'));
  }
  return parts.join('');
}

function renderDrawPalette() {
  if (!drawPaletteEl) return;
  drawPaletteEl.textContent = '';
  for (const tool of DRAW_TOOLSETS[drawMode] ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = tool.id === drawTool ? 'is-active' : '';
    button.dataset.drawTool = tool.id;
    button.textContent = tool.label;
    button.title = tool.family;
    button.addEventListener('click', () => {
      drawTool = tool.id;
      renderDrawing();
    });
    drawPaletteEl.appendChild(button);
  }
}

function drawItemLabel(item) {
  const tool = Object.values(DRAW_TOOLSETS).flat().find((entry) => entry.id === item.type);
  if (tool) return `${tool.label} / ${tool.family}`;
  if (item.type === 'line') return `線 (${item.x1}, ${item.y1}) → (${item.x2}, ${item.y2})`;
  if (item.type === 'rect') return `四角 (${item.x}, ${item.y})`;
  if (item.type === 'circle') return `円 (${item.cx}, ${item.cy})`;
  return `ラベル ${item.text}`;
}

function addDrawItemAt(x, y) {
  pushDrawHistory();
  const id = drawNextId++;
  const base = { id, color: 'blue!70!black', weight: 2, dash: 'solid', fill: 'none', opacity: 100, rotate: 0, scale: 1 };
  if (drawTool === 'line') {
    drawItems.push({ ...base, type: 'line', x1: x - 32, y1: y + 18, x2: x + 32, y2: y - 18 });
  } else if (drawTool === 'arrow') {
    drawItems.push({ ...base, type: 'arrow', x1: x - 36, y1: y + 18, x2: x + 36, y2: y - 18, arrowTip: 'Stealth' });
  } else if (drawTool === 'rect') {
    drawItems.push({ ...base, type: 'rect', x: x - 36, y: y - 22, w: 72, h: 44, fill: 'blue!10', rounded: 0 });
  } else if (drawTool === 'circle') {
    drawItems.push({ ...base, type: 'circle', cx: x, cy: y, r: 26, fill: 'blue!10' });
  } else if (drawTool === 'ellipse') {
    drawItems.push({ ...base, type: 'ellipse', cx: x, cy: y, rx: 38, ry: 22, fill: 'blue!10' });
  } else if (drawTool === 'label' || drawTool === 'node') {
    drawItems.push({ ...base, type: 'label', x: x - 10, y, text: `P${id}`, color: 'black', nodeShape: drawTool === 'node' ? 'rounded rectangle' : 'rectangle' });
  } else if (drawTool === 'polyline') {
    drawItems.push({ ...base, type: 'polyline', x, y, points: '0,0; 1,0.8; 2,0.2; 3,1' });
  } else if (drawTool === 'bezier') {
    drawItems.push({ ...base, type: 'bezier', x, y, points: '0,0; 1,1.4; 2,-0.5; 3,0.8' });
  } else if (drawTool === 'background') {
    drawItems.push({ ...base, type: 'background', x, y, fill: 'yellow!20', color: 'orange!80!black', layerText: 'background' });
  } else if (drawTool === 'double-line') {
    drawItems.push({ ...base, type: 'double-line', x1: x - 60, y1: y + 12, x2: x + 60, y2: y - 12, color: 'purple', weight: 1.2 });
  } else if (drawTool === 'clip-fill') {
    drawItems.push({ ...base, type: 'clip-fill', x, y, fill: 'green!10', color: 'green!55!black', opacity: 85 });
  } else if (['custom', 'custom3d', 'custom-plot'].includes(drawTool)) {
    drawItems.push({ ...base, type: drawTool, x, y, customBody: defaultCustomTikzBody(drawTool), view: drawTool === 'custom3d' ? 'x={(-0.35cm,-0.2cm)},y={(1cm,0cm)},z={(0cm,1cm)}' : '' });
  } else {
    drawItems.push({
      ...base,
      type: drawTool,
      x,
      y,
      expression: defaultDrawExpression(drawTool),
      domainFrom: 0,
      domainTo: defaultDomainTo(drawTool),
      xLabel: 'x',
      yLabel: 'y',
      legend: defaultDrawLegend(drawTool),
      axisOptions: defaultAxisOptions(drawTool),
      patternType: 'north east lines',
      arrowTip: 'Stealth',
      nodeShape: 'rounded rectangle',
      view: isDraw3dType(drawTool) ? 'x={(-0.35cm,-0.2cm)},y={(1cm,0cm)},z={(0cm,1cm)}' : '',
    });
  }
  selectedDrawId = id;
  renderDrawing();
}

function selectedDrawItem() {
  return drawItems.find((entry) => entry.id === selectedDrawId) ?? null;
}

function duplicateSelectedDrawItem() {
  const item = selectedDrawItem();
  if (!item) return;
  pushDrawHistory();
  const id = drawNextId++;
  const copy = { ...item, id };
  for (const key of ['x', 'x1', 'x2', 'cx']) if (key in copy) copy[key] += 14;
  for (const key of ['y', 'y1', 'y2', 'cy']) if (key in copy) copy[key] += 14;
  drawItems.push(copy);
  selectedDrawId = id;
  renderDrawing();
}

function moveSelectedDrawItem(delta) {
  const index = drawItems.findIndex((entry) => entry.id === selectedDrawId);
  if (index < 0) return;
  const nextIndex = Math.max(0, Math.min(drawItems.length - 1, index + delta));
  if (nextIndex === index) return;
  pushDrawHistory();
  const [item] = drawItems.splice(index, 1);
  drawItems.splice(nextIndex, 0, item);
  renderDrawing();
}

function deleteSelectedDrawItem() {
  const item = selectedDrawItem();
  if (!item) return;
  pushDrawHistory();
  drawItems = drawItems.filter((entry) => entry.id !== item.id);
  selectedDrawId = drawItems[0]?.id ?? null;
  renderDrawing();
}

function isTypingInFormControl(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
}

function isDrawPanelActive() {
  return document.querySelector('[data-panel="draw"]')?.classList.contains('is-active');
}

function nudgeSelectedDrawItem(dx, dy) {
  const item = selectedDrawItem();
  if (!item) return false;
  pushDrawHistory();
  translateDrawItem(item, dx, dy);
  renderDrawing();
  return true;
}

function translateDrawItem(item, dx, dy) {
  for (const key of ['x', 'x1', 'x2', 'cx']) {
    if (key in item && Number.isFinite(Number(item[key]))) item[key] = Number(item[key]) + dx;
  }
  for (const key of ['y', 'y1', 'y2', 'cy']) {
    if (key in item && Number.isFinite(Number(item[key]))) item[key] = Number(item[key]) + dy;
  }
}

function drawSnapshot() {
  return {
    items: JSON.parse(JSON.stringify(drawItems)),
    selectedId: selectedDrawId,
    nextId: drawNextId,
  };
}

function restoreDrawSnapshot(snapshot) {
  drawItems = JSON.parse(JSON.stringify(snapshot.items ?? []));
  selectedDrawId = snapshot.selectedId ?? drawItems[0]?.id ?? null;
  drawNextId = snapshot.nextId ?? (Math.max(0, ...drawItems.map((item) => item.id ?? 0)) + 1);
  drawDragState = null;
  suppressNextDrawClick = false;
  renderDrawing();
}

function pushDrawHistory() {
  drawUndoStack.push(drawSnapshot());
  if (drawUndoStack.length > DRAW_HISTORY_LIMIT) drawUndoStack.shift();
  drawRedoStack.length = 0;
}

function undoDrawing() {
  if (!drawUndoStack.length) return;
  drawRedoStack.push(drawSnapshot());
  restoreDrawSnapshot(drawUndoStack.pop());
}

function redoDrawing() {
  if (!drawRedoStack.length) return;
  drawUndoStack.push(drawSnapshot());
  restoreDrawSnapshot(drawRedoStack.pop());
}

function resizeDrawItem(item, handle, point) {
  if (handle === 'start') {
    item.x1 = point.x;
    item.y1 = point.y;
  } else if (handle === 'end') {
    item.x2 = point.x;
    item.y2 = point.y;
  } else if (handle === 'nw') {
    const right = Number(item.x) + Number(item.w);
    const bottom = Number(item.y) + Number(item.h);
    item.x = Math.min(point.x, right - 8);
    item.y = Math.min(point.y, bottom - 8);
    item.w = Math.max(8, right - item.x);
    item.h = Math.max(8, bottom - item.y);
  } else if (handle === 'se') {
    item.w = Math.max(8, point.x - Number(item.x));
    item.h = Math.max(8, point.y - Number(item.y));
  } else if (handle === 'radius') {
    item.r = Math.max(4, Math.round(Math.hypot(point.x - item.cx, point.y - item.cy)));
  } else if (handle === 'rx') {
    item.rx = Math.max(4, Math.abs(point.x - item.cx));
  } else if (handle === 'ry') {
    item.ry = Math.max(4, Math.abs(point.y - item.cy));
  } else if (handle === 'origin') {
    item.x = point.x;
    item.y = point.y;
  }
}

function onDrawDragMove(ev) {
  if (!drawDragState) return;
  const item = drawItems.find((entry) => entry.id === drawDragState.id);
  if (!item) {
    drawDragState = null;
    return;
  }
  const point = svgPointFromEvent(ev);
  if (drawDragState.handle) {
    resizeDrawItem(item, drawDragState.handle, point);
    drawDragState.last = point;
    drawDragState.moved = true;
    renderDrawing();
    return;
  }
  const dx = point.x - drawDragState.last.x;
  const dy = point.y - drawDragState.last.y;
  if (!dx && !dy) return;
  translateDrawItem(item, dx, dy);
  drawDragState.last = point;
  drawDragState.moved = true;
  renderDrawing();
}

function endDrawDrag() {
  if (drawDragState?.moved) suppressNextDrawClick = true;
  drawDragState = null;
}

function addCurrentDrawTool() {
  addDrawItemAt(180, 120);
}

function ensureDrawArrowMarker() {
  if (drawSvgEl.querySelector('#draw-arrow')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.id = 'draw-arrow';
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
  path.setAttribute('fill', '#1f6f8f');
  marker.appendChild(path);
  defs.appendChild(marker);
  drawSvgEl.appendChild(defs);
}

function drawPreviewAxes(item) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('class', 'draw-shape');
  bindDrawSvgElement(group, item);
  group.classList.toggle('is-selected', item.id === selectedDrawId);
  const x0 = item.x ?? 180;
  const y0 = item.y ?? 120;
  group.innerHTML = `<line x1="${x0 - 80}" y1="${y0}" x2="${x0 + 88}" y2="${y0}"/><line x1="${x0}" y1="${y0 + 70}" x2="${x0}" y2="${y0 - 78}"/>`;
  drawSvgEl.appendChild(group);
}

function drawPreviewGrid(item = null) {
  for (let x = 40; x <= 320; x += 40) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'draw-shape');
    if (item) bindDrawSvgElement(line, item);
    line.setAttribute('x1', x);
    line.setAttribute('y1', 30);
    line.setAttribute('x2', x);
    line.setAttribute('y2', 210);
    drawSvgEl.appendChild(line);
  }
}

function drawPreviewPolyline(item) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path.setAttribute('class', 'draw-shape');
  path.setAttribute('fill', 'none');
  applyPreviewStyle(path, item);
  bindDrawSvgElement(path, item);
  const points = parsePointList(item.points, [[0, 0], [1, 0.8], [2, 0.2], [3, 1]])
    .map(([x, y]) => `${60 + x * 60},${180 - y * 60}`)
    .join(' ');
  path.setAttribute('points', points);
  drawSvgEl.appendChild(path);
}

function drawPreviewCube(item) {
  const x = item.x ?? 180;
  const y = item.y ?? 120;
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  poly.setAttribute('class', 'draw-shape');
  bindDrawSvgElement(poly, item);
  poly.classList.toggle('is-selected', item.id === selectedDrawId);
  poly.setAttribute('d', `M${x - 45},${y - 25} h70 v55 h-70 z M${x - 25},${y - 45} h70 v55 M${x + 25},${y - 25} l20,-20 M${x + 25},${y + 30} l20,-20 M${x - 45},${y - 25} l20,-20`);
  drawSvgEl.appendChild(poly);
}

function drawPreviewPlot(item) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'draw-shape');
  path.setAttribute('fill', 'none');
  applyPreviewStyle(path, item);
  bindDrawSvgElement(path, item);
  path.setAttribute('d', 'M40,150 C95,40 145,210 205,105 S300,50 330,120');
  drawSvgEl.appendChild(path);
}

function drawPreviewBars(item) {
  [70, 120, 170, 220, 270].forEach((x, i) => {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'draw-shape');
    applyPreviewStyle(rect, item);
    bindDrawSvgElement(rect, item);
    rect.setAttribute('x', x);
    rect.setAttribute('y', 160 - i * 18);
    rect.setAttribute('width', 28);
    rect.setAttribute('height', 60 + i * 18);
    drawSvgEl.appendChild(rect);
  });
}

function drawPreviewGraph(item) {
  const pts = [[90, 140], [170, 80], [250, 145], [175, 185]];
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'draw-shape');
    applyPreviewStyle(line, item);
    bindDrawSvgElement(line, item);
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    drawSvgEl.appendChild(line);
  }
  pts.forEach(([x, y], i) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'draw-shape');
    applyPreviewStyle(circle, item);
    bindDrawSvgElement(circle, item);
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', 13);
    drawSvgEl.appendChild(circle);
  });
}

function drawPreviewAnnotation(item) {
  const x = item.x ?? 160;
  const y = item.y ?? 120;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'draw-shape');
  applyPreviewStyle(line, item);
  bindDrawSvgElement(line, item);
  if (item.type === 'brace') line.setAttribute('d', `M${x - 55},${y} C${x - 40},${y - 25} ${x - 20},${y - 25} ${x},${y} C${x + 20},${y + 25} ${x + 40},${y + 25} ${x + 55},${y}`);
  else if (item.type === 'snake') line.setAttribute('d', `M${x - 70},${y} q10,-18 20,0 t20,0 t20,0 t20,0 t20,0 t20,0 t20,0`);
  else line.setAttribute('d', `M${x - 70},${y} H${x + 70} M${x - 70},${y - 8} v16 M${x + 70},${y - 8} v16`);
  drawSvgEl.appendChild(line);
}

function drawPreviewLayerFeature(item) {
  const x = item.x ?? 160;
  const y = item.y ?? 120;
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  bindDrawSvgElement(group, item);
  if (item.type === 'background') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x - 70);
    rect.setAttribute('y', y - 34);
    rect.setAttribute('width', 140);
    rect.setAttribute('height', 68);
    rect.setAttribute('rx', 8);
    rect.setAttribute('fill', previewColor(item.fill ?? 'yellow!20'));
    rect.setAttribute('stroke', previewColor(item.color ?? 'orange!80!black'));
    rect.setAttribute('opacity', '0.55');
    group.appendChild(rect);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x - 52);
    text.setAttribute('y', y + 4);
    text.setAttribute('class', 'draw-label');
    text.textContent = item.layerText || 'background';
    group.appendChild(text);
  } else {
    const a = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    a.setAttribute('cx', x - 18);
    a.setAttribute('cy', y);
    a.setAttribute('r', 34);
    a.setAttribute('fill', previewColor(item.fill ?? 'green!10'));
    a.setAttribute('stroke', previewColor(item.color ?? 'green!55!black'));
    a.setAttribute('opacity', '0.65');
    group.appendChild(a);
    const b = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    b.setAttribute('cx', x + 18);
    b.setAttribute('cy', y);
    b.setAttribute('r', 34);
    b.setAttribute('fill', 'none');
    b.setAttribute('stroke', previewColor(item.color ?? 'green!55!black'));
    b.setAttribute('stroke-dasharray', '6 4');
    group.appendChild(b);
  }
  drawSvgEl.appendChild(group);
}

function drawPreviewBadge(item) {
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('class', 'draw-label');
  bindDrawSvgElement(text, item);
  text.setAttribute('x', item.x ?? 150);
  text.setAttribute('y', item.y ?? 120);
  text.textContent = drawItemLabel(item);
  drawSvgEl.appendChild(text);
}

function svgPointFromEvent(ev) {
  const rect = drawSvgEl.getBoundingClientRect();
  let x = ((ev.clientX - rect.left) / rect.width) * 360;
  let y = ((ev.clientY - rect.top) / rect.height) * 240;
  if (drawSnapEl?.checked) {
    const grid = Math.max(5, Number(drawGridSizeEl?.value || 20));
    x = Math.round(x / grid) * grid;
    y = Math.round(y / grid) * grid;
  }
  return {
    x: Math.max(0, Math.min(360, Math.round(x))),
    y: Math.max(0, Math.min(240, Math.round(y))),
  };
}

function tikzCoord(x, y) {
  return `${(x / 60).toFixed(2)},${((240 - y) / 60).toFixed(2)}`;
}

function tikzColor(value) {
  if (!value || value.startsWith('#')) return 'blue!70!black';
  return value;
}

function tikzStyle(item, extras = []) {
  const options = [...extras];
  if (item.color) options.push(`draw=${tikzColor(item.color)}`);
  if (item.weight) options.push(`line width=${Number(item.weight).toFixed(1)}pt`);
  if (item.dash === 'dashed') options.push('dashed');
  if (item.dash === 'dotted') options.push('dotted');
  if (item.fill && item.fill !== 'none') options.push(`fill=${tikzColor(item.fill)}`);
  if (item.opacity != null && Number(item.opacity) < 100) options.push(`opacity=${Math.max(0, Math.min(1, Number(item.opacity) / 100)).toFixed(2)}`);
  if (item.scale && Number(item.scale) !== 1) options.push(`scale=${Number(item.scale).toFixed(2)}`);
  if (item.customOptions) options.push(...String(item.customOptions).split(',').map((option) => option.trim()).filter(Boolean));
  return options.join(',');
}

function tikzDraw(item, extras = []) {
  const style = tikzStyle(item, extras);
  return style ? `[${style}]` : '';
}

function tikzExpression(item, fallback) {
  return (item.expression ?? '').trim() || fallback;
}

function tikzDomain(item, fallbackFrom, fallbackTo) {
  const from = Number.isFinite(Number(item.domainFrom)) ? Number(item.domainFrom) : fallbackFrom;
  const to = Number.isFinite(Number(item.domainTo)) ? Number(item.domainTo) : fallbackTo;
  return `domain=${from}:${to}`;
}

function tikzArrow(item) {
  return `-{${item.arrowTip || 'Stealth'}}`;
}

function tikzTransformScope(item, bodyLines, center) {
  const rotate = Number(item.rotate || 0);
  if (!rotate) return bodyLines;
  return [
    `  \\begin{scope}[rotate around={${rotate}:(${center})}]`,
    ...bodyLines.map((line) => `  ${line}`),
    '  \\end{scope}',
  ];
}

function parsePointList(value, fallback) {
  const points = String(value ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(',').map((num) => Number(num.trim())))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
  return points.length ? points : fallback;
}

function tikzPointList(value, fallback) {
  return parsePointList(value, fallback).map(([x, y]) => `(${x},${y})`);
}

function pgfColor(value) {
  if (!value) return 'blue';
  if (value.startsWith('blue')) return 'blue';
  if (value.startsWith('red')) return 'red';
  if (value.startsWith('green')) return 'green!60!black';
  if (value.startsWith('purple')) return 'purple';
  if (value.startsWith('orange')) return 'orange!80!black';
  if (value.startsWith('gray')) return 'gray';
  if (value.startsWith('black')) return 'black';
  return 'blue';
}

function pgfPlotStyle(item) {
  const style = [pgfColor(item.color), `line width=${Number(item.weight || 1.5).toFixed(1)}pt`];
  if (item.dash === 'dashed') style.push('dashed');
  if (item.dash === 'dotted') style.push('dotted');
  if (item.customOptions) style.push(...String(item.customOptions).split(',').map((part) => part.trim()).filter(Boolean));
  return style.join(',');
}

function pgfSeriesStyle(index) {
  return ['blue,thick', 'red,dashed,thick', 'green!60!black,densely dotted,thick', 'purple,thick'][index % 4];
}

function pgfExpression(item, fallback) {
  return String(tikzExpression(item, fallback)).replace(/\\x/g, 'x');
}

function pgfSeries(item) {
  const series = String(item.expression ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\\x/g, 'x'));
  return series.length ? series : ['x', 'x^2'];
}

function pgfTableRows(value, fallback) {
  const rows = String(value ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/,/g, ' ').replace(/\s+/g, ' '));
  return rows.length ? rows : fallback;
}

function pgfAxisOptions(item) {
  const options = [
    'width=7cm',
    'height=4.5cm',
    `xlabel={${escapeLatexText(item.xLabel || 'x')}}`,
    `ylabel={${escapeLatexText(item.yLabel || 'y')}}`,
  ];
  if (item.axisOptions) options.push(...String(item.axisOptions).split(',').map((part) => part.trim()).filter(Boolean));
  if (item.legend) options.push(`legend entries={${escapeLatexText(item.legend)}}`);
  return options.join(',');
}

function pgfAxisLines(item, bodyLines) {
  return [
    `  \\begin{axis}[${pgfAxisOptions(item)}]`,
    ...bodyLines,
    '  \\end{axis}',
  ];
}

function defaultCustomTikzBody(type) {
  if (type === 'custom3d') return '\\draw[->] (0,0,0) -- (1.5,1,1) node[right] {$v$};';
  if (type === 'custom-plot') return '\\begin{axis}[width=6cm,height=4cm,grid=both]\n\\addplot[blue,domain=0:3,smooth] {sin(deg(x))};\n\\end{axis}';
  return '\\draw (0,0) -- (1,1) node[right] {custom};';
}

function defaultDrawLegend(type) {
  if (type === 'multi-plot') return 'x,x^2,sqrt(x)';
  if (type === 'axis-plot') return 'f(x)';
  if (type === 'error-bars') return '測定値';
  if (type === 'heatmap') return '値';
  return '';
}

function defaultAxisOptions(type) {
  if (type === 'heatmap') return 'view={0}{90},colorbar';
  if (type === 'error-bars') return 'grid=both';
  return 'grid=both';
}

function buildTikzFigure() {
  const caption = drawCaptionEl?.value?.trim() || '作成した図';
  const label = `fig:${slugifyLabel(caption)}`;
  const view = drawItems.find((item) => item.view)?.view?.trim();
  const pictureOptions = ['scale=1'];
  if (view) pictureOptions.push(view);
  const lines = [
    '',
    '\\begin{figure}[t]',
    '\\centering',
    `\\begin{tikzpicture}[${pictureOptions.join(',')}]`,
  ];
  for (const item of drawItems) {
    if (item.type === 'line') {
      const center = tikzCoord((item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2);
      lines.push(...tikzTransformScope(item, [`\\draw${tikzDraw(item)} (${tikzCoord(item.x1, item.y1)}) -- (${tikzCoord(item.x2, item.y2)});`], center));
    } else if (item.type === 'rect') {
      const rounded = item.rounded ? [`rounded corners=${Number(item.rounded).toFixed(1)}pt`] : [];
      const center = tikzCoord(item.x + item.w / 2, item.y + item.h / 2);
      lines.push(...tikzTransformScope(item, [`\\draw${tikzDraw(item, rounded)} (${tikzCoord(item.x, item.y + item.h)}) rectangle (${tikzCoord(item.x + item.w, item.y)});`], center));
    } else if (item.type === 'circle') {
      lines.push(`  \\draw${tikzDraw(item)} (${tikzCoord(item.cx, item.cy)}) circle (${(item.r / 60).toFixed(2)});`);
    } else if (item.type === 'ellipse') {
      lines.push(...tikzTransformScope(item, [`\\draw${tikzDraw(item)} (${tikzCoord(item.cx, item.cy)}) ellipse (${(item.rx / 60).toFixed(2)} and ${(item.ry / 60).toFixed(2)});`], tikzCoord(item.cx, item.cy)));
    } else if (item.type === 'arrow') {
      const center = tikzCoord((item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2);
      lines.push(...tikzTransformScope(item, [`\\draw${tikzDraw(item, [tikzArrow(item)])} (${tikzCoord(item.x1, item.y1)}) -- (${tikzCoord(item.x2, item.y2)});`], center));
    } else if (item.type === 'label') {
      const shape = item.nodeShape && item.nodeShape !== 'rectangle' ? `${item.nodeShape},draw=${tikzColor(item.color)}` : `text=${tikzColor(item.color)}`;
      lines.push(`  \\node[${shape},transform shape,scale=${Number(item.scale || 1).toFixed(2)}] at (${tikzCoord(item.x, item.y)}) {${escapeLatexText(item.text)}};`);
    } else if (['custom', 'custom3d', 'custom-plot'].includes(item.type)) {
      lines.push(...String(item.customBody || defaultCustomTikzBody(item.type)).split('\n').map((line) => `  ${line}`));
    } else {
      lines.push(...tikzPresetLines(item));
    }
  }
  lines.push('\\end{tikzpicture}');
  lines.push(`\\caption{${escapeLatexText(caption)}}`);
  lines.push(`\\label{${label}}`);
  lines.push('\\end{figure}');
  return lines.join('\n') + '\n';
}

function tikzPresetLines(item) {
  const c = tikzCoord(item.x ?? 180, item.y ?? 120);
  switch (item.type) {
    case 'polyline':
      return [`  \\draw${tikzDraw(item)} ${tikzPointList(item.points, [[0, 0], [1, 0.8], [2, 0.2], [3, 1]]).join(' -- ')};`];
    case 'arc':
      return [`  \\draw${tikzDraw(item)} (${c}) ++(0:1) arc[start angle=0,end angle=130,radius=1];`];
    case 'bezier':
      {
        const pts = tikzPointList(item.points, [[0, 0], [1, 1.4], [2, -0.5], [3, 0.8]]);
        return [`  \\draw${tikzDraw(item)} ${pts[0]} .. controls ${pts[1]} and ${pts[2]} .. ${pts[3]};`];
      }
    case 'grid':
      return ['  \\draw[step=0.5,help lines] (0,0) grid (5,3);'];
    case 'axes':
      return ['  \\draw[->] (-0.2,0) -- (5,0) node[right] {$x$};', '  \\draw[->] (0,-0.2) -- (0,3) node[above] {$y$};'];
    case 'node':
      return [`  \\node[draw=${tikzColor(item.color)},rounded corners,fill=${item.fill === 'none' ? 'white' : tikzColor(item.fill)}] at (${c}) {node};`];
    case 'fill':
      return ['  \\fill[blue!18] (0,0) rectangle (2,1);', '  \\draw[thick] (0,0) rectangle (2,1);'];
    case 'pattern':
      return [`  \\path[pattern=${item.patternType || 'north east lines'},pattern color=${tikzColor(item.color)}] (0,0) rectangle (2.2,1.2);`];
    case 'background':
      return [
        '  \\node[draw,rounded corners,fill=white,inner sep=8pt] (main) at (0,0) {main object};',
        '  \\begin{scope}[on background layer]',
        `    \\node[fill=${tikzColor(item.fill === 'none' ? 'yellow!20' : item.fill)},draw=${tikzColor(item.color)},rounded corners,fit=(main),inner sep=14pt,label=below:${escapeLatexText(item.layerText || 'background')}] {};`,
        '  \\end{scope}',
      ];
    case 'double-line':
      return [`  \\draw${tikzDraw(item, ['double', 'double distance=2pt'])} (0,0) -- (3,0.7) node[midway,above] {double};`];
    case 'clip-fill':
      return [
        '  \\begin{scope}',
        '    \\clip (0,0) circle (1);',
        `    \\fill[${tikzColor(item.fill === 'none' ? 'green!15' : item.fill)}] (0.65,0) circle (1);`,
        '  \\end{scope}',
        `  \\draw${tikzDraw(item)} (0,0) circle (1);`,
        `  \\draw${tikzDraw(item, ['dashed'])} (0.65,0) circle (1);`,
      ];
    case 'clip':
      return ['  \\begin{scope}', '    \\clip (0,0) circle (1);', '    \\draw[step=0.25,help lines] (-1,-1) grid (1,1);', '  \\end{scope}'];
    case 'scope':
      return ['  \\begin{scope}[shift={(1,1)},rotate=20]', '    \\draw[thick] (0,0) rectangle (1.5,0.8);', '  \\end{scope}'];
    case 'dimension':
      return [`  \\draw${tikzDraw(item, ['{Stealth}-{Stealth}'])} (0,0) -- (3,0) node[midway,above] {3 cm};`];
    case 'angle':
      return [
        '  \\coordinate (A) at (0,0);',
        '  \\coordinate (B) at (2,0);',
        '  \\coordinate (C) at (1.4,1.2);',
        `  \\draw${tikzDraw(item)} (A) -- (B) -- (C);`,
        '  \\pic[draw,->,"$\\theta$",angle eccentricity=1.35,angle radius=8mm] {angle=A--B--C};',
      ];
    case 'brace':
      return [`  \\draw${tikzDraw(item, ['decorate', 'decoration={brace,amplitude=5pt}'])} (0,0) -- (3,0) node[midway,above=6pt] {group};`];
    case 'snake':
      return [`  \\draw${tikzDraw(item, ['decorate', 'decoration={snake,amplitude=1.5pt,segment length=8pt}'])} (0,0) -- (3,0);`];
    case 'intersection':
      return [
        '  \\path[name path=a] (0,0) -- (3,2);',
        '  \\path[name path=b] (0,2) -- (3,0);',
        '  \\draw[blue,thick,name path=a] (0,0) -- (3,2);',
        '  \\draw[red,thick,name path=b] (0,2) -- (3,0);',
        '  \\path[name intersections={of=a and b,by=P}];',
        '  \\fill[black] (P) circle (2pt) node[above] {$P$};',
      ];
    case 'fit':
      return [
        '  \\node[draw,circle] (a) at (0,0) {A};',
        '  \\node[draw,circle] (b) at (2,0.8) {B};',
        '  \\node[draw,circle] (c) at (1,-0.9) {C};',
        '  \\node[draw,rounded corners,fit=(a) (b) (c),inner sep=8pt,label=above:group] {};',
      ];
    case 'callout':
      return [
        '  \\node[draw,rounded rectangle,fill=blue!10] (target) at (0,0) {target};',
        '  \\node[draw,cloud callout,callout relative pointer={(0.8,-0.6)},fill=yellow!20] at (2,1.2) {note};',
      ];
    case 'foreach':
      return [
        `  \\foreach \\x/\\y/\\t in {0/0/A,1/0.5/B,2/0/C,3/0.7/D}{`,
        `    \\node[draw,circle,fill=${tikzColor(item.fill === 'none' ? 'blue!10' : item.fill)}] at (\\x,\\y) {\\t};`,
        '  }',
      ];
    case 'axis3d':
      return [`  \\draw${tikzDraw(item, ['->'])} (0,0,0) -- (3,0,0) node[right] {$x$};`, `  \\draw${tikzDraw(item, ['->'])} (0,0,0) -- (0,3,0) node[above] {$y$};`, `  \\draw${tikzDraw(item, ['->'])} (0,0,0) -- (0,0,3) node[below left] {$z$};`];
    case 'cube':
      return [`  \\draw${tikzDraw(item)} (0,0,0) -- (2,0,0) -- (2,2,0) -- (0,2,0) -- cycle;`, `  \\draw${tikzDraw(item)} (0,0,2) -- (2,0,2) -- (2,2,2) -- (0,2,2) -- cycle;`, `  \\draw${tikzDraw(item)} (0,0,0) -- (0,0,2) (2,0,0) -- (2,0,2) (2,2,0) -- (2,2,2) (0,2,0) -- (0,2,2);`];
    case 'plane3d':
      return ['  \\filldraw[blue!12,draw=blue!60] (0,0,0) -- (3,0,0) -- (3,2,1) -- (0,2,1) -- cycle;'];
    case 'vector3d':
      return [`  \\draw${tikzDraw(item, [tikzArrow(item)])} (0,0,0) -- (2,1,1.5) node[right] {$\\vec v$};`];
    case 'surface':
      return [`  \\foreach \\x in {0,0.25,...,3}{\\draw[${tikzColor(item.color)}] plot[domain=0:3] (\\x,\\x/4,{${tikzExpression(item, 'sin(\\x*60)/3')}});}`];
    case 'sphere':
      return ['  \\shade[ball color=blue!20] (0,0) circle (1.2);', '  \\draw[dashed] (-1.2,0) arc[start angle=180,end angle=360,x radius=1.2,y radius=0.35);'];
    case 'cylinder':
      return ['  \\draw[thick] (-1,0) arc[start angle=180,end angle=360,x radius=1,y radius=.35];', '  \\draw[thick] (-1,2) arc[start angle=180,end angle=540,x radius=1,y radius=.35];', '  \\draw[thick] (-1,0) -- (-1,2) (1,0) -- (1,2);'];
    case 'cone':
      return ['  \\draw[thick] (-1,0) arc[start angle=180,end angle=360,x radius=1,y radius=.35];', '  \\draw[dashed] (-1,0) arc[start angle=180,end angle=0,x radius=1,y radius=.35];', '  \\draw[thick] (-1,0) -- (0,2.2) -- (1,0);'];
    case 'torus':
      return ['  \\draw[thick] (0,0) ellipse (1.6 and 0.55);', '  \\draw[thick] (0,0) ellipse (0.75 and 0.25);', '  \\draw[dashed] (-1.6,0) arc[start angle=180,end angle=360,x radius=1.6,y radius=.55];'];
    case 'projection':
      return ['  \\draw[->] (0,0,0) -- (2,1,1);', '  \\draw[dashed] (2,1,1) -- (2,1,0);'];
    case 'rotate3d':
      return ['  \\begin{scope}[rotate around x=25,rotate around y=35]', '    \\draw[thick] (0,0,0) circle (1);', '  \\end{scope}'];
    case 'function':
      return ['  \\draw[->] (-0.2,0) -- (4,0) node[right] {$x$};', '  \\draw[->] (0,-0.2) -- (0,3) node[above] {$y$};', `  \\draw${tikzDraw(item, [tikzDomain(item, 0, 3.6), 'smooth'])} plot (\\x,{${tikzExpression(item, '0.4*\\x*\\x')}});`];
    case 'parametric':
      return [`  \\draw${tikzDraw(item, [tikzDomain(item, 0, 360), 'smooth', 'variable=\\t'])} plot ${tikzExpression(item, '({cos(\\t)},{sin(2*\\t)})')};`];
    case 'scatter':
      return [`  \\foreach \\x/\\y in {${tikzExpression(item, '0.4/0.8,1/1.3,1.8/1.1,2.4/2,3/1.7')}}{\\fill[${tikzColor(item.color)}] (\\x,\\y) circle (2pt);}`];
    case 'bar':
      return [`  \\foreach \\x/\\h in {${tikzExpression(item, '0.5/1,1.2/1.8,1.9/1.3,2.6/2.2')}}{\\filldraw[${tikzColor(item.fill === 'none' ? 'blue!20' : item.fill)},draw=${tikzColor(item.color)}] (\\x,0) rectangle +(0.45,\\h);}`];
    case 'area':
      return [`  \\fill[${tikzColor(item.fill === 'none' ? 'blue!18' : item.fill)}] (0,0) -- plot[${tikzDomain(item, 0, 3)}] (\\x,{${tikzExpression(item, 'sin(\\x*60)+1.4')}}) -- (${Number(item.domainTo ?? 3)},0) -- cycle;`, `  \\draw${tikzDraw(item, [tikzDomain(item, 0, 3), 'smooth'])} plot (\\x,{${tikzExpression(item, 'sin(\\x*60)+1.4')}});`];
    case 'polar':
      return [`  \\draw${tikzDraw(item, [tikzDomain(item, 0, 360), 'smooth', 'variable=\\t'])} plot ({${tikzExpression(item, '(1+0.4*cos(3*\\t))')}*cos(\\t)},{${tikzExpression(item, '(1+0.4*cos(3*\\t))')}*sin(\\t)});`];
    case 'histogram':
      return [`  \\foreach \\x/\\h in {${tikzExpression(item, '0/0.6,0.5/1.4,1/2.1,1.5/1.6,2/0.9')}}{\\filldraw[${tikzColor(item.fill === 'none' ? 'green!20' : item.fill)},draw=${tikzColor(item.color)}] (\\x,0) rectangle +(0.45,\\h);}`];
    case 'axis-plot':
      return pgfAxisLines(item, [
        `    \\addplot[${pgfPlotStyle(item)},domain=${Number(item.domainFrom ?? 0)}:${Number(item.domainTo ?? 3.6)},smooth] {${pgfExpression(item, 'x^2')}};`,
      ]);
    case 'multi-plot':
      return pgfAxisLines(item, pgfSeries(item).map((expr, index) => `    \\addplot[${pgfSeriesStyle(index)},domain=${Number(item.domainFrom ?? 0)}:${Number(item.domainTo ?? 3.6)},smooth] {${expr}};`));
    case 'error-bars':
      return pgfAxisLines(item, [
        `    \\addplot+[${pgfPlotStyle(item)},only marks,error bars/.cd,y dir=both,y explicit] table[x index=0,y index=1,y error index=2,row sep=crcr] {`,
        ...pgfTableRows(item.expression, ['0 1 0.1', '1 1.7 0.2', '2 1.3 0.15', '3 2.1 0.25']).map((row) => `      ${row}\\\\`),
        '    };',
      ]);
    case 'heatmap':
      return pgfAxisLines(item, [
        '    \\addplot3[surf,shader=flat,mesh/rows=2] coordinates {',
        ...pgfTableRows(item.expression, ['0 0 1', '0 1 2', '1 0 2', '1 1 4']).map((row) => `      (${row.replace(/\\s+/g, ',')})`),
        '    };',
      ]);
    case 'graph-nodes':
      return ['  \\node[draw,circle] (a) at (0,0) {A};', '  \\node[draw,circle] (b) at (2,1) {B};', '  \\node[draw,circle] (c) at (2,-1) {C};', '  \\draw[->] (a) -- (b); \\draw[->] (a) -- (c); \\draw (b) -- (c);'];
    case 'flowchart':
      return [
        '  \\node[draw,rounded rectangle,fill=blue!10] (start) at (0,0) {Start};',
        '  \\node[draw,diamond,aspect=2,fill=yellow!20,below=8mm of start] (test) {OK?};',
        '  \\node[draw,rounded rectangle,fill=green!10,below left=8mm and 8mm of test] (yes) {Yes};',
        '  \\node[draw,rounded rectangle,fill=red!10,below right=8mm and 8mm of test] (no) {No};',
        '  \\draw[->] (start) -- (test); \\draw[->] (test) -- node[left] {true} (yes); \\draw[->] (test) -- node[right] {false} (no);',
      ];
    case 'tree':
      return ['  \\node {root} child {node {left}} child {node {right}};'];
    case 'mindmap':
      return [
        '  \\begin{scope}[mindmap,concept color=blue!40,text=white]',
        '    \\node[concept] {Main}',
        '      child[concept color=green!50!black] { node[concept] {A} }',
        '      child[concept color=orange] { node[concept] {B} }',
        '      child[concept color=purple] { node[concept] {C} };',
        '  \\end{scope}',
      ];
    case 'automaton':
      return [
        '  \\node[state,initial] (q0) at (0,0) {$q_0$};',
        '  \\node[state,accepting] (q1) at (2.4,0) {$q_1$};',
        '  \\path[->] (q0) edge[loop above] node {0} (q0) edge[bend left] node {1} (q1) (q1) edge[bend left] node {0} (q0) edge[loop above] node {1} (q1);',
      ];
    case 'commutative':
      return ['  \\matrix (m) [matrix of math nodes,row sep=1cm,column sep=1cm]{ A & B \\\\ C & D \\\\};', '  \\draw[->] (m-1-1) -- (m-1-2); \\draw[->] (m-1-1) -- (m-2-1); \\draw[->] (m-1-2) -- (m-2-2); \\draw[->] (m-2-1) -- (m-2-2);'];
    default:
      return [`  \\node at (${c}) {${escapeLatexText(drawItemLabel(item))}};`];
  }
}

function insertDrawing() {
  if (!drawItems.length) return;
  const source = ensureDrawingPackages(editor.value, drawItems);
  editor.value = insertTexAtTarget(source, buildTikzFigure(), drawTargetEl?.value || 'end');
  scheduleSync();
  statusEl.textContent = '作図ツールから図を追加しました';
  setWorkspaceMode('edit');
}

function ensureTikzLibraries(source) {
  const libs = ['arrows.meta', 'calc', 'positioning', 'matrix', 'patterns', 'decorations.pathmorphing', 'decorations.pathreplacing', 'shapes.geometric', 'shapes.misc', 'shapes.callouts', '3d', 'plotmarks', 'angles', 'quotes', 'intersections', 'fit', 'backgrounds', 'mindmap', 'automata'];
  const existingLibs = source.match(/\\usetikzlibrary\{([^{}]*)\}/);
  if (existingLibs) {
    const current = existingLibs[1].split(',').map((part) => part.trim()).filter(Boolean);
    const merged = [...current];
    for (const lib of libs) if (!merged.includes(lib)) merged.push(lib);
    return source.slice(0, existingLibs.index) + `\\usetikzlibrary{${merged.join(',')}}` + source.slice(existingLibs.index + existingLibs[0].length);
  }
  const useTikz = source.match(/\\usepackage(?:\[[^\]]*\])?\{tikz\}/);
  if (useTikz) {
    const insertAt = useTikz.index + useTikz[0].length;
    return source.slice(0, insertAt) + `\n\\usetikzlibrary{${libs.join(',')}}` + source.slice(insertAt);
  }
  const docClass = source.match(/\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}/);
  if (docClass) {
    const insertAt = docClass.index + docClass[0].length;
    return source.slice(0, insertAt) + `\n\\usepackage{tikz}\n\\usetikzlibrary{${libs.join(',')}}` + source.slice(insertAt);
  }
  return `\\usepackage{tikz}\n\\usetikzlibrary{${libs.join(',')}}\n` + source;
}

function ensureDrawingPackages(source, items = []) {
  let next = ensureTikzLibraries(source);
  if (items.some((item) => ['axis-plot', 'multi-plot', 'error-bars', 'heatmap', 'custom-plot'].includes(item.type) || /\\begin\{axis\}/.test(item.customBody ?? ''))) {
    next = ensurePackage(next, 'pgfplots');
    next = ensurePgfplotsCompat(next);
  }
  return next;
}

function ensurePackage(source, packageName) {
  const re = new RegExp(`\\\\\\\\usepackage(?:\\\\[[^\\\\]]*\\\\])?\\\\{${escapeRegExp(packageName)}\\\\}`);
  if (re.test(source)) return source;
  const docClass = source.match(/\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}/);
  if (docClass) {
    const insertAt = docClass.index + docClass[0].length;
    return source.slice(0, insertAt) + `\n\\usepackage{${packageName}}` + source.slice(insertAt);
  }
  return `\\usepackage{${packageName}}\n` + source;
}

function insertPreambleSnippet(source, snippet) {
  const lines = String(snippet || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const missing = lines.filter((line) => !source.includes(line));
  if (!missing.length) return source;
  const block = `\n${missing.join('\n')}\n`;
  const begin = source.match(/\\begin\{document\}/);
  if (begin) return source.slice(0, begin.index) + block + source.slice(begin.index);
  const docClass = source.match(/\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}/);
  if (docClass) {
    const insertAt = docClass.index + docClass[0].length;
    return source.slice(0, insertAt) + block + source.slice(insertAt);
  }
  return `${missing.join('\n')}\n${source}`;
}

function ensureTheoremEnvironments(source, envs = []) {
  let next = ensurePackage(source, 'amsthm');
  const definitions = {
    theorem: '\\newtheorem{theorem}{Theorem}[section]',
    lemma: '\\newtheorem{lemma}[theorem]{Lemma}',
    definition: '\\newtheorem{definition}{Definition}[section]',
  };
  for (const env of envs) {
    if (!definitions[env]) continue;
    const re = new RegExp(`\\\\newtheorem\\{${env}\\}`);
    if (re.test(next)) continue;
    const amsthm = next.match(/\\usepackage(?:\[[^\]]*\])?\{amsthm\}/);
    if (amsthm) {
      const insertAt = amsthm.index + amsthm[0].length;
      next = next.slice(0, insertAt) + `\n${definitions[env]}` + next.slice(insertAt);
    } else {
      next = `${definitions[env]}\n` + next;
    }
  }
  return next;
}

function ensurePgfplotsCompat(source) {
  if (/\\pgfplotsset\{compat=/.test(source)) return source;
  const pkg = source.match(/\\usepackage(?:\[[^\]]*\])?\{pgfplots\}/);
  if (pkg) {
    const insertAt = pkg.index + pkg[0].length;
    return source.slice(0, insertAt) + '\n\\pgfplotsset{compat=1.18}' + source.slice(insertAt);
  }
  return source;
}

document.querySelectorAll('.draw-mode').forEach((button) => {
  button.addEventListener('click', () => {
    drawMode = button.dataset.drawMode;
    drawTool = DRAW_TOOLSETS[drawMode][0].id;
    document.querySelectorAll('.draw-mode').forEach((el) => el.classList.toggle('is-active', el === button));
    renderDrawing();
  });
});

drawAddButton?.addEventListener('click', addCurrentDrawTool);
drawUndoButton?.addEventListener('click', undoDrawing);
drawRedoButton?.addEventListener('click', redoDrawing);
drawDuplicateButton?.addEventListener('click', duplicateSelectedDrawItem);
drawBackButton?.addEventListener('click', () => moveSelectedDrawItem(-1));
drawFrontButton?.addEventListener('click', () => moveSelectedDrawItem(1));
drawDeleteButton?.addEventListener('click', deleteSelectedDrawItem);

drawSvgEl?.addEventListener('click', (ev) => {
  if (suppressNextDrawClick) {
    suppressNextDrawClick = false;
    return;
  }
  const point = svgPointFromEvent(ev);
  addDrawItemAt(point.x, point.y);
});

window.addEventListener('mousemove', onDrawDragMove);
window.addEventListener('mouseup', endDrawDrag);
window.addEventListener('keydown', (ev) => {
  if (!isDrawPanelActive() || isTypingInFormControl(ev.target)) return;
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) redoDrawing();
    else undoDrawing();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'y') {
    ev.preventDefault();
    redoDrawing();
    return;
  }
  const step = ev.shiftKey ? 10 : 2;
  const moves = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  if (moves[ev.key]) {
    const [dx, dy] = moves[ev.key];
    if (nudgeSelectedDrawItem(dx, dy)) ev.preventDefault();
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (selectedDrawItem()) {
      ev.preventDefault();
      deleteSelectedDrawItem();
    }
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'd') {
    if (selectedDrawItem()) {
      ev.preventDefault();
      duplicateSelectedDrawItem();
    }
  }
});

drawClearButton?.addEventListener('click', () => {
  if (drawItems.length) pushDrawHistory();
  drawItems = [];
  selectedDrawId = null;
  renderDrawing();
});

drawInsertButton?.addEventListener('click', insertDrawing);

renderDrawing();


// ------------------------------------------------- PPT-style box editing
//
// Every block (paragraph, heading, equation, caption...) is an editable
// region: hovering outlines it, clicking opens an overlay editor holding
// exactly that block's source slice. Each keystroke rebuilds the main
// buffer and rides the normal 40ms edit pipeline, so the page reflows
// around the box as you type.

const hoverBox = document.createElement('div');
hoverBox.id = 'hoverbox';
const selectedPreviewBox = document.createElement('div');
selectedPreviewBox.id = 'selected-preview-box';
const previewInsertButton = document.createElement('button');
previewInsertButton.type = 'button';
previewInsertButton.className = 'preview-insert-button';
previewInsertButton.textContent = '+';
previewInsertButton.title = 'この位置に編集領域を追加';
function handlePreviewInsertButtonPress(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  openPreviewInsertPanel(previewInsertButton.dataset.targetSrc, previewInsertButton.closest('.page'));
}
previewInsertButton.addEventListener('pointerdown', handlePreviewInsertButtonPress);
previewInsertButton.addEventListener('mousedown', handlePreviewInsertButtonPress);
previewInsertButton.addEventListener('click', handlePreviewInsertButtonPress);
const previewInsertPanel = document.createElement('div');
previewInsertPanel.className = 'preview-insert-panel';
let boxState = null; // {src, start, len, wrap, ta, pageDiv, closing}
let boxComposing = false;

const MATH_PLACEHOLDER_LATEX = '\\placeholder{}';
const MATH_KEYBOARD_TABS = [
  { id: 'analysis', label: '解析' },
  { id: 'algebra', label: '代数' },
  { id: 'sets', label: '集合' },
  { id: 'logic', label: '論理' },
  { id: 'arrows', label: '矢印' },
  { id: 'greek', label: 'ギリシャ' },
];
const STYLE_WRAPPER_TEMPLATE_RE =
  /^\\(?:mathbb|mathcal|mathfrak|mathbf|mathrm|mathit|mathsf|mathtt)\{#\?\}$/;
let mathKeyboardDataPromise = null;

function loadMathKeyboardData() {
  if (!mathKeyboardDataPromise) {
    mathKeyboardDataPromise = import('/math-keyboard-data.js').catch((err) => {
      console.warn('math keyboard data failed to load:', err);
      return { mathKeyboardFixedKeys: [], mathKeyboardSets: {} };
    });
  }
  return mathKeyboardDataPromise;
}

function srcOf(target) {
  const closest = target?.closest?.('[data-src]');
  const src =
    target?.dataset?.src ??
    target?.getAttribute?.('data-src') ??
    closest?.dataset?.src ??
    closest?.getAttribute?.('data-src');
  if (!src || src.startsWith('_')) return null;
  return src;
}

function sourceHitFromEvent(ev) {
  const direct = srcOf(ev.target);
  if (direct) {
    return {
      src: direct,
      el: ev.target?.closest?.('[data-src]') ?? ev.target,
    };
  }
  const pageDiv = ev.target?.closest?.('.page') ?? ev.target?.ownerSVGElement?.closest?.('.page');
  if (!pageDiv) return null;
  const el = nearestSourceElement(pageDiv, ev.clientX, ev.clientY);
  const src = srcOf(el);
  return src ? { src, el } : null;
}

function nearestSourceElement(pageDiv, x, y) {
  let best = null;
  const els = pageDiv.querySelectorAll('svg [data-src], .hitbox[data-src], .chunkwin[data-src]');
  for (const el of els) {
    const src = srcOf(el);
    if (!src) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const pad = 3;
    const inside =
      x >= rect.left - pad &&
      x <= rect.right + pad &&
      y >= rect.top - pad &&
      y <= rect.bottom + pad;
    const cx = Math.max(rect.left, Math.min(x, rect.right));
    const cy = Math.max(rect.top, Math.min(y, rect.bottom));
    const dist = inside ? 0 : (cx - x) ** 2 + (cy - y) ** 2;
    if (!best || dist < best.dist) best = { el, dist };
  }
  return best && best.dist <= 144 ? best.el : null;
}

function blockRect(pageDiv, src, anchorEl = null, point = null) {
  const els = pageDiv.querySelectorAll(`[data-src="${src}"]`);
  if (!els.length) return null;
  const p = pageDiv.getBoundingClientRect();
  const anchorHitbox = anchorEl?.classList?.contains('hitbox') ? anchorEl : anchorEl?.closest?.('.hitbox[data-src]');
  if (anchorHitbox?.getAttribute?.('data-src') === src) {
    const rect = anchorHitbox.getBoundingClientRect();
    return rectToPagePct(rect, p, 0);
  }
  const rects = [...els]
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width !== 0 || rect.height !== 0);
  if (!rects.length) return null;
  let selectedRects = rects.map(({ rect }) => rect);
  const isMulticol = [...els].some((el) => el.getAttribute?.('data-layout') === 'multicol');
  const anchor = anchorEl?.closest?.(`[data-src="${src}"]`) ?? (anchorEl?.dataset?.src === src ? anchorEl : null);
  let anchorRect = anchor?.getBoundingClientRect?.() ?? null;
  if (!anchorRect && point) {
    let best = null;
    for (const { rect } of rects) {
      const cx = Math.max(rect.left, Math.min(point.x, rect.right));
      const cy = Math.max(rect.top, Math.min(point.y, rect.bottom));
      const dist = (cx - point.x) ** 2 + (cy - point.y) ** 2;
      if (!best || dist < best.dist) best = { rect, dist };
    }
    anchorRect = best?.rect ?? null;
  }
  if (anchorRect) {
    let candidates = rects.map(({ rect }) => rect);
    const lineStarts = columnLineStarts(candidates, p.width);
    const splitInfo = columnSplitFromStarts(lineStarts, p.width);
    if (splitInfo || (isMulticol && point)) {
      const anchorCenter = (anchorRect.left + anchorRect.right) / 2;
      const split = splitInfo?.split ?? (p.left + p.width / 2);
      const left = anchorCenter < split ? -Infinity : split;
      const right = anchorCenter < split ? split : Infinity;
      const anchorIsWide = anchorRect.width >= p.width * 0.65;
      const sameColumn = candidates.filter((rect) => {
        if (!anchorIsWide && rect.width >= p.width * 0.65) return false;
        const center = (rect.left + rect.right) / 2;
        return center >= left && center <= right;
      });
      if (sameColumn.length) candidates = sameColumn;
    }
    const sorted = candidates.sort((a, b) => a.top - b.top || a.left - b.left);
    const anchorIndex = sorted.findIndex((rect) => rect.left === anchorRect.left && rect.top === anchorRect.top && rect.right === anchorRect.right && rect.bottom === anchorRect.bottom);
    if (anchorIndex >= 0) {
      let first = anchorIndex;
      let last = anchorIndex;
      const maxGap = 28;
      while (first > 0 && sorted[first].top - sorted[first - 1].bottom <= maxGap) first--;
      while (last < sorted.length - 1 && sorted[last + 1].top - sorted[last].bottom <= maxGap) last++;
      selectedRects = sorted.slice(first, last + 1);
    }
  }
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const q of selectedRects) {
    l = Math.min(l, q.left); t = Math.min(t, q.top);
    r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  if (!isFinite(l)) return null;
  const pad = 5;
  return rectToPagePct({ left: l, top: t, right: r, bottom: b }, p, pad);
}

function rectToPagePct(rect, pageRect, pad = 0) {
  return {
    left: ((rect.left - pageRect.left - pad) / pageRect.width) * 100,
    top: ((rect.top - pageRect.top - pad) / pageRect.height) * 100,
    width: ((rect.right - rect.left + 2 * pad) / pageRect.width) * 100,
    height: ((rect.bottom - rect.top + 2 * pad) / pageRect.height) * 100,
  };
}

function columnLineStarts(rects, pageWidth) {
  const sorted = rects
    .filter((rect) => rect.width > 0 && rect.width < pageWidth * 0.65)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const rect of sorted) {
    let line = lines[lines.length - 1];
    if (!line || Math.abs(rect.top - line.top) > 3.5) {
      line = { top: rect.top, left: rect.left, right: rect.right, count: 0 };
      lines.push(line);
    }
    line.left = Math.min(line.left, rect.left);
    line.right = Math.max(line.right, rect.right);
    line.count++;
  }
  return lines
    .filter((line) => line.count >= 2 && line.right - line.left < pageWidth * 0.65)
    .map((line) => line.left)
    .sort((a, b) => a - b);
}

function columnSplitFromStarts(starts, pageWidth) {
  if (starts.length < 10) return null;
  let widestGap = 0;
  let gapAt = -1;
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    if (gap > widestGap) {
      widestGap = gap;
      gapAt = i;
    }
  }
  const leftCount = gapAt > 0 ? gapAt : 0;
  const rightCount = gapAt > 0 ? starts.length - gapAt : 0;
  if (widestGap < pageWidth * 0.2 || leftCount < 4 || rightCount < 4) return null;
  return { split: (starts[gapAt - 1] + starts[gapAt]) / 2 };
}

function highlightSelectedPreviewBlock(src = selectedWordBlockId, { scroll = false } = {}) {
  if (!src) {
    selectedPreviewBox.style.display = 'none';
    return;
  }
  const pageDiv = [...document.querySelectorAll('.page')].find((page) => page.querySelector(`[data-src="${src}"]`));
  if (!pageDiv) {
    selectedPreviewBox.style.display = 'none';
    return;
  }
  const rect = blockRect(pageDiv, src);
  if (!rect) {
    selectedPreviewBox.style.display = 'none';
    return;
  }
  if (selectedPreviewBox.parentElement !== pageDiv) pageDiv.appendChild(selectedPreviewBox);
  Object.assign(selectedPreviewBox.style, {
    display: 'block',
    left: rect.left + '%',
    top: rect.top + '%',
    width: rect.width + '%',
    height: rect.height + '%',
  });
  if (scroll) pageDiv.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
}

pagesEl.addEventListener('mousemove', (ev) => {
  if (boxState) return;
  const hit = sourceHitFromEvent(ev);
  const src = hit?.src;
  const pageDiv = hit?.el?.closest?.('.page') ?? ev.target?.closest?.('.page');
  if (!src || !pageDiv) { hidePreviewInsertionAffordance(); return; }
  const rect = blockRect(pageDiv, src, hit.el ?? ev.target, { x: ev.clientX, y: ev.clientY });
  if (!rect) { hidePreviewInsertionAffordance(); return; }
  if (hoverBox.parentElement !== pageDiv) pageDiv.appendChild(hoverBox);
  Object.assign(hoverBox.style, {
    display: 'block',
    left: rect.left + '%',
    top: rect.top + '%',
    width: rect.width + '%',
    height: rect.height + '%',
  });
  placePreviewInsertButton(pageDiv, src, rect);
});
pagesEl.addEventListener('mouseleave', () => {
  if (!boxState && !previewInsertPanel.matches(':hover')) hidePreviewInsertionAffordance();
});

pagesEl.addEventListener('click', (ev) => {
  const addButton = ev.target.closest?.('.preview-insert-button');
  if (!addButton) return;
  ev.preventDefault();
  ev.stopPropagation();
  openPreviewInsertPanel(addButton.dataset.targetSrc, addButton.closest('.page'));
});

function hidePreviewInsertionAffordance() {
  hoverBox.style.display = 'none';
}

function placePreviewInsertButton(pageDiv, src, rect) {
  if (previewInsertButton.parentElement !== pageDiv) pageDiv.appendChild(previewInsertButton);
  previewInsertButton.dataset.targetSrc = src;
  Object.assign(previewInsertButton.style, {
    display: 'grid',
    left: Math.min(98, Math.max(2, rect.left + rect.width)) + '%',
    top: Math.min(98, Math.max(2, rect.top + rect.height)) + '%',
  });
}

function openPreviewInsertPanel(targetSrc, pageDiv) {
  if (!targetSrc || !pageDiv) return;
  closeBox();
  previewInsertPanel.dataset.targetSrc = targetSrc;
  previewInsertPanel.innerHTML = `
    <label>種類
      <select data-preview-insert-type>
        <option value="paragraph">本文</option>
        <option value="section">節</option>
        <option value="subsection">小節</option>
        <option value="equation">数式</option>
        <option value="align">整列数式</option>
        <option value="itemize">箇条書き</option>
        <option value="enumerate">番号付きリスト</option>
        <option value="description">説明リスト</option>
        <option value="quote">引用</option>
      </select>
    </label>
    <label>タイトル
      <input data-preview-insert-title type="text" placeholder="見出し・名前">
    </label>
    <label class="preview-insert-wide">内容
      <textarea data-preview-insert-body placeholder="ここに追加する内容を書く"></textarea>
    </label>
    <div class="preview-insert-actions">
      <button type="button" data-preview-insert-cancel>閉じる</button>
      <button type="button" data-preview-insert-commit>追加</button>
    </div>
  `;
  if (previewInsertPanel.parentElement !== pageDiv) pageDiv.appendChild(previewInsertPanel);
  const buttonRect = previewInsertButton.getBoundingClientRect();
  const pageRect = pageDiv.getBoundingClientRect();
  Object.assign(previewInsertPanel.style, {
    left: `${Math.min(72, Math.max(2, ((buttonRect.left - pageRect.left) / pageRect.width) * 100))}%`,
    top: `${Math.min(88, Math.max(2, ((buttonRect.top - pageRect.top) / pageRect.height) * 100))}%`,
  });
  previewInsertPanel.querySelector('[data-preview-insert-body]')?.focus();
}

previewInsertPanel.addEventListener('mousedown', (ev) => ev.stopPropagation());
previewInsertPanel.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (ev.target.closest('[data-preview-insert-cancel]')) {
    previewInsertPanel.remove();
    return;
  }
  if (ev.target.closest('[data-preview-insert-commit]')) {
    insertFromPreviewPanel();
  }
});

function insertFromPreviewPanel() {
  const targetSrc = previewInsertPanel.dataset.targetSrc || 'end';
  const type = previewInsertPanel.querySelector('[data-preview-insert-type]')?.value || 'paragraph';
  const title = previewInsertPanel.querySelector('[data-preview-insert-title]')?.value?.trim() || '';
  const body = previewInsertPanel.querySelector('[data-preview-insert-body]')?.value?.trim() || '';
  const tex = buildPreviewInsertTex(type, title, body);
  editor.value = insertTexAtTarget(editor.value, tex, targetSrc);
  previewInsertPanel.remove();
  scheduleSync();
  statusEl.textContent = 'プレビュー上から編集領域を追加しました';
}

function buildPreviewInsertTex(type, title, body) {
  const text = body || (type === 'equation' || type === 'align' ? 'x = y' : 'ここに本文を入力します。');
  const heading = title || '新しい項目';
  if (type === 'section') return `\n\\section{${escapeLatexText(heading)}}\n\\label{sec:${slugifyLabel(heading)}}\n\n${escapeLatexText(text)}\n`;
  if (type === 'subsection') return `\n\\subsection{${escapeLatexText(heading)}}\n\\label{sec:${slugifyLabel(heading)}}\n\n${escapeLatexText(text)}\n`;
  if (type === 'equation') return `\n\\begin{equation}\n  \\label{eq:${slugifyLabel(heading || text.slice(0, 32))}}\n  ${escapeLatexMath(text)}\n\\end{equation}\n`;
  if (type === 'align') {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index, arr) => `  ${escapeLatexMath(line)}${index < arr.length - 1 ? ' \\\\' : ''}`);
    return `\n\\begin{align}\n  \\label{eq:${slugifyLabel(heading || text.slice(0, 32))}}\n${lines.join('\n')}\n\\end{align}\n`;
  }
  if (type === 'itemize' || type === 'enumerate' || type === 'description') return '\n' + buildListTex(type, text);
  if (type === 'quote') return `\n\\begin{quote}\n${escapeLatexText(text)}\n\\end{quote}\n`;
  return `\n${escapeLatexText(text)}\n`;
}

async function openBox(src, anchorEl = null, point = null) {
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
  const rect = blockRect(pageDiv, src, anchorEl, point);
  if (!rect) return;
  hoverBox.style.display = 'none';

  const start = block.span.start;
  const slice = editor.value.slice(start, block.span.end);
  const blockEditor = createBlockEditor(slice);
  const wrap = document.createElement('div');
  wrap.className = 'boxedit';
  if (blockEditor.kind) wrap.dataset.editorKind = blockEditor.kind;
  placeBoxEdit(wrap, rect);
  const hint = document.createElement('div');
  hint.className = 'boxhint';
  hint.textContent = 'Esc / 枠外クリックで確定';
  wrap.appendChild(blockEditor.el);
  wrap.appendChild(hint);
  wrap.addEventListener('mousedown', (ev) => ev.stopPropagation());
  wrap.addEventListener('click', (ev) => ev.stopPropagation());
  pageDiv.appendChild(wrap);

  boxState = {
    src,
    start,
    len: slice.length,
    wrap,
    editor: blockEditor,
    pageDiv,
    closing: null,
  };
  blockEditor.grow();
  blockEditor.focus();

  wrap.addEventListener('compositionstart', () => (boxComposing = true));
  wrap.addEventListener('compositionend', () => { boxComposing = false; onBoxInput(); });
  wrap.addEventListener('input', () => { blockEditor.grow(); if (!boxComposing) onBoxInput(); });
  wrap.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeBox(); }
  });
  wrap.addEventListener('focusout', () => {
    const state = boxState;
    if (!state) return;
    state.closing = setTimeout(() => {
      if (boxState !== state) return;
      if (state.wrap.matches(':hover') || state.wrap.contains(document.activeElement)) {
        state.closing = null;
        return;
      }
      closeBox();
    }, 180);
  });
  wrap.addEventListener('focusin', () => {
    if (boxState?.closing) { clearTimeout(boxState.closing); boxState.closing = null; }
  });
}

function onBoxInput() {
  if (!boxState) return;
  const s = boxState;
  const next = s.editor.value();
  editor.value = editor.value.slice(0, s.start) + next + editor.value.slice(s.start + s.len);
  s.len = next.length;
  scheduleSync();
}

const COMMAND_FIELD_LABELS = {
  abstract: '要約',
  author: '著者',
  caption: 'キャプション',
  chapter: '章',
  cite: '引用',
  date: '日付',
  emph: '強調',
  eqref: '式参照',
  footnote: '脚注',
  label: 'ラベル',
  paragraph: '段落見出し',
  ref: '参照',
  section: '見出し',
  subparagraph: '小段落見出し',
  subsection: '小見出し',
  subsubsection: '小小見出し',
  term: '用語',
  textbf: '太字',
  textit: '斜体',
  title: 'タイトル',
};

const LENS_COMMANDS = new Set(Object.keys(COMMAND_FIELD_LABELS));

function createBlockEditor(source) {
  const mathLens = parseMathLens(source);
  if (mathLens) {
    const mathEditor = createMathLensEditor(source, mathLens);
    if (mathEditor) return mathEditor;
  }
  const commandLens = parseCommandLens(source);
  if (commandLens) return createCommandLensEditor(source, commandLens);
  const wordModel = previewWordModelFromSource(source);
  if (wordModel) return createPreviewWordModelEditor(wordModel);
  const inlineMathEditor = createInlineMathBlockEditor(source);
  if (inlineMathEditor) return inlineMathEditor;
  return createSourceTextareaEditor(source);
}

function previewWordModelFromSource(source) {
  const model = wordModelFromSource(source, { span: { start: 0, end: source.length } });
  if (!model) return null;
  if (['paragraph', 'float'].includes(model.kind)) return null;
  return model;
}

function createPreviewWordModelEditor(model) {
  const form = document.createElement('div');
  form.className = 'boxword';
  form.dataset.modelKind = model.kind;
  if (['code', 'theoremLike'].includes(model.kind)) {
    form.appendChild(boxWordInputRow('タイトル', 'title', model.title ?? ''));
  }
  if (model.label !== null) {
    form.appendChild(boxWordInputRow('ラベル', 'label', model.label ?? ''));
  }
  const bodyRow = document.createElement('label');
  bodyRow.className = 'boxword-field boxword-wide';
  const bodyName = document.createElement('span');
  bodyName.textContent = model.bodyLabel || '本文';
  const body = document.createElement('textarea');
  body.dataset.wordField = 'body';
  body.value = model.body ?? '';
  body.spellcheck = !['math', 'code', 'simpleTable'].includes(model.kind);
  bodyRow.appendChild(bodyName);
  bodyRow.appendChild(body);
  form.appendChild(bodyRow);
  const controls = [...form.querySelectorAll('input, textarea')];
  return {
    kind: `word-${model.kind}`,
    el: form,
    value: () => buildWordModelSource(model, form),
    focus: () => {
      const first = controls[0];
      first?.focus();
      if (typeof first?.setSelectionRange === 'function') first.setSelectionRange(0, 0);
    },
    grow: () => {
      for (const control of controls) {
        if (control.tagName !== 'TEXTAREA') continue;
        control.style.height = 'auto';
        control.style.height = Math.min(control.scrollHeight + 2, model.kind === 'code' ? 320 : 240) + 'px';
      }
    },
  };
}

function boxWordInputRow(labelText, field, value) {
  const row = document.createElement('label');
  row.className = 'boxword-field';
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.wordField = field;
  input.value = value;
  row.appendChild(label);
  row.appendChild(input);
  return row;
}

function createSourceTextareaEditor(source) {
  const ta = document.createElement('textarea');
  ta.value = source;
  ta.spellcheck = false;
  return {
    el: ta,
    value: () => ta.value,
    focus: () => {
      ta.focus();
      ta.setSelectionRange(0, 0);
    },
    grow: () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
    },
  };
}

function createCommandLensEditor(source, lens) {
  const root = document.createElement('div');
  root.className = 'boxfields';
  const controls = [];
  for (const field of lens.fields) {
    const row = document.createElement('label');
    row.className = 'boxfield';
    const name = document.createElement('span');
    name.className = 'boxfield-name';
    name.textContent = field.label;
    const control = document.createElement(field.value.includes('\n') ? 'textarea' : 'input');
    control.className = 'boxfield-control';
    control.value = field.value;
    control.spellcheck = false;
    row.appendChild(name);
    row.appendChild(control);
    root.appendChild(row);
    controls.push(control);
  }
  return {
    el: root,
    value: () => rebuildCommandLens(source, lens, controls.map((c) => c.value)),
    focus: () => {
      const first = controls[0];
      first?.focus();
      first?.setSelectionRange(0, 0);
    },
    grow: () => {
      for (const control of controls) {
        if (control.tagName !== 'TEXTAREA') continue;
        control.style.height = 'auto';
        control.style.height = Math.min(control.scrollHeight + 2, 220) + 'px';
      }
    },
  };
}

function createMathLensEditor(source, lens) {
  if (!ensureMathLiveElement()) return null;
  const root = document.createElement('div');
  root.className = 'boxmath';

  const mathLabel = document.createElement('div');
  mathLabel.className = 'boxmath-label';
  mathLabel.textContent = lens.kind === 'inline' ? 'インライン数式' : '数式';
  root.appendChild(mathLabel);

  const mathRows = splitMathRows(lens.math);
  const mathfields = [];
  let activeMathfield = null;
  let mathTextArea = null;
  let syncingMathText = false;
  const mathfieldHost = document.createElement('div');
  mathfieldHost.className = mathRows.length > 1 ? 'boxmath-lines' : 'boxmath-single';
  function syncMathTextFromFields() {
    if (!mathTextArea || syncingMathText) return;
    syncingMathText = true;
    mathTextArea.value = readMathFieldRows(mathfields, lens).join('\n');
    autosizeMathTextArea(mathTextArea);
    syncingMathText = false;
  }
  function syncMathFieldsFromText() {
    if (!mathTextArea || syncingMathText) return;
    const rows = splitMathTextAreaRows(mathTextArea.value);
    if (rows.length !== mathfields.length) return;
    syncingMathText = true;
    rows.forEach((row, index) => writeMathFieldValue(mathfields[index], row));
    syncingMathText = false;
  }
  for (let i = 0; i < mathRows.length; i++) {
    const row = document.createElement('div');
    row.className = 'boxmath-line';
    const mathfield = document.createElement('math-field');
    mathfield.className = 'boxmath-field';
    mathfield.setAttribute('virtual-keyboard-mode', 'manual');
    mathfield.setAttribute('math-virtual-keyboard-policy', 'manual');
    mathfield.setAttribute('placeholder', 'Enter formula');
    row.appendChild(mathfield);
    mathfieldHost.appendChild(row);
    mathfields.push(mathfield);
    mathfield.addEventListener('focusin', () => {
      activeMathfield = mathfield;
    });
    mathfield.addEventListener('input', syncMathTextFromFields);
    configureMathField(mathfield);
    writeMathFieldValue(mathfield, mathRows[i]);
  }
  activeMathfield = mathfields[0] ?? null;
  root.appendChild(mathfieldHost);

  if (mathRows.length > 1) {
    const textRow = document.createElement('label');
    textRow.className = 'boxmath-textrow';
    const textLabel = document.createElement('span');
    textLabel.className = 'boxmath-label';
    textLabel.textContent = '行編集';
    mathTextArea = document.createElement('textarea');
    mathTextArea.className = 'boxmath-textarea';
    mathTextArea.value = mathRows.join('\n');
    mathTextArea.spellcheck = false;
    mathTextArea.addEventListener('input', () => {
      autosizeMathTextArea(mathTextArea);
      syncMathFieldsFromText();
    });
    textRow.appendChild(textLabel);
    textRow.appendChild(mathTextArea);
    root.appendChild(textRow);
    autosizeMathTextArea(mathTextArea);
  }

  const controls = { mathfields, labelInput: null, mathTextArea };
  if (lens.label !== null) {
    const row = document.createElement('label');
    row.className = 'boxfield boxmath-ref';
    const name = document.createElement('span');
    name.className = 'boxfield-name';
    name.textContent = 'ラベル';
    const labelInput = document.createElement('input');
    labelInput.className = 'boxfield-control';
    labelInput.value = lens.label;
    labelInput.spellcheck = false;
    row.appendChild(name);
    row.appendChild(labelInput);
    root.appendChild(row);
    controls.labelInput = labelInput;
  }

  const keyboard = createMathKeyboardPanel(() => activeMathfield ?? mathfields[0] ?? null);
  root.appendChild(keyboard.el);

  return {
    kind: 'math',
    el: root,
    value: () => rebuildMathLens(lens, {
      math: controls.mathTextArea ? readMathTextAreaValue(controls.mathTextArea, lens) : readMathRowsValue(mathfields, lens),
      label: controls.labelInput?.value ?? null,
    }),
    focus: () => {
      const mathfield = mathfields[0];
      activeMathfield = mathfield;
      mathfield.focus();
      if (typeof mathfield.executeCommand === 'function') {
        mathfield.executeCommand('moveToMathfieldEnd');
      }
    },
    grow: () => {},
    destroy: () => keyboard.destroy(),
  };
}

function createInlineMathBlockEditor(source) {
  const lenses = parseInlineMathLenses(source);
  if (!lenses.length || !ensureMathLiveElement()) return null;
  const root = document.createElement('div');
  root.className = 'boxmath boxmath-inline';

  const mathLabel = document.createElement('div');
  mathLabel.className = 'boxmath-label';
  mathLabel.textContent = lenses.length === 1 ? 'インライン数式' : `インライン数式 ${lenses.length}件`;
  root.appendChild(mathLabel);

  const textareas = [];
  const mathfields = [];
  let activeMathfield = null;
  let cursor = 0;

  function appendTextSegment(value, index) {
    const textRow = document.createElement('label');
    textRow.className = 'boxmath-textrow boxmath-inline-text';
    const textLabel = document.createElement('span');
    textLabel.className = 'boxmath-label';
    textLabel.textContent = index === 0 ? '前の本文' : index === lenses.length ? '後の本文' : '間の本文';
    const textarea = document.createElement('textarea');
    textarea.className = 'boxmath-textarea';
    textarea.value = value;
    textarea.spellcheck = true;
    textarea.addEventListener('input', () => autosizeMathTextArea(textarea));
    textRow.appendChild(textLabel);
    textRow.appendChild(textarea);
    root.appendChild(textRow);
    textareas.push(textarea);
    autosizeMathTextArea(textarea);
  }

  lenses.forEach((lens, index) => {
    appendTextSegment(source.slice(cursor, lens.outerStart), index);
    const row = document.createElement('div');
    row.className = 'boxmath-inline-row';
    if (lenses.length > 1) {
      const rowLabel = document.createElement('div');
      rowLabel.className = 'boxmath-label';
      rowLabel.textContent = `式 ${index + 1}`;
      row.appendChild(rowLabel);
    }
    const mathfield = document.createElement('math-field');
    mathfield.className = 'boxmath-field';
    mathfield.setAttribute('virtual-keyboard-mode', 'manual');
    mathfield.setAttribute('math-virtual-keyboard-policy', 'manual');
    mathfield.setAttribute('placeholder', 'Enter formula');
    row.appendChild(mathfield);
    root.appendChild(row);
    mathfields.push(mathfield);
    mathfield.addEventListener('focusin', () => {
      activeMathfield = mathfield;
    });
    configureMathField(mathfield);
    writeMathFieldValue(mathfield, lens.math.trim());
    cursor = lens.outerEnd;
  });
  appendTextSegment(source.slice(cursor), lenses.length);

  activeMathfield = mathfields[0] ?? null;
  const keyboard = createMathKeyboardPanel(() => activeMathfield ?? mathfields[0] ?? null);
  root.appendChild(keyboard.el);

  return {
    kind: 'math',
    el: root,
    value: () =>
      rebuildInlineMathBlockFromControls(
        lenses,
        textareas.map((textarea) => textarea.value),
        mathfields.map((mathfield) => readMathFieldValue(mathfield).trim())
      ),
    focus: () => {
      const firstText = textareas.find((textarea) => textarea.value.trim()) ?? textareas[0];
      if (firstText) {
        firstText.focus();
        firstText.setSelectionRange(0, 0);
        return;
      }
      const mathfield = mathfields[0];
      activeMathfield = mathfield;
      mathfield?.focus();
      if (typeof mathfield?.executeCommand === 'function') {
        mathfield.executeCommand('moveToMathfieldEnd');
      }
    },
    grow: () => {
      for (const textarea of textareas) autosizeMathTextArea(textarea);
    },
    destroy: () => keyboard.destroy(),
  };
}

function splitMathRows(math) {
  const rows = [];
  let current = '';
  let braceDepth = 0;
  let envDepth = 0;
  for (let i = 0; i < math.length; i++) {
    const rest = math.slice(i);
    const beginMatch = rest.match(/^\\begin\{([^{}]+)\}/);
    if (beginMatch) {
      envDepth++;
      current += beginMatch[0];
      i += beginMatch[0].length - 1;
      continue;
    }
    const endMatch = rest.match(/^\\end\{([^{}]+)\}/);
    if (endMatch) {
      envDepth = Math.max(0, envDepth - 1);
      current += endMatch[0];
      i += endMatch[0].length - 1;
      continue;
    }
    if (math[i] === '\\' && math[i + 1] === '\\' && braceDepth === 0 && envDepth === 0) {
      rows.push(current.trim());
      current = '';
      i++;
      let j = i + 1;
      while (j < math.length && /[ \t]/.test(math[j])) j++;
      if (math[j] === '[') {
        const opt = readBalanced(math, j, '[', ']');
        if (opt) j = opt.end;
      }
      while (j < math.length && /\s/.test(math[j])) j++;
      i = j - 1;
      continue;
    }
    if (math[i] === '\\' && i + 1 < math.length) {
      current += math[i] + math[i + 1];
      i++;
      continue;
    }
    if (math[i] === '{') braceDepth++;
    else if (math[i] === '}') braceDepth = Math.max(0, braceDepth - 1);
    current += math[i];
  }
  rows.push(current.trim());
  return rows.length ? rows : [''];
}

function readMathRowsValue(mathfields, lens) {
  return readMathFieldRows(mathfields, lens).join(' \\\\\n');
}

function readMathFieldRows(mathfields, lens) {
  return mathfields.map((mathfield) => normalizeMathRowValue(readMathFieldValue(mathfield), lens).trim());
}

function readMathTextAreaValue(textarea, lens) {
  return splitMathTextAreaRows(textarea.value)
    .map((row) => normalizeMathRowValue(row, lens).trim())
    .join(' \\\\\n');
}

function splitMathTextAreaRows(value) {
  const rows = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop();
  return rows.length ? rows : [''];
}

function autosizeMathTextArea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight + 2, 180) + 'px';
}

function normalizeMathRowValue(value, lens) {
  if (lens.kind === 'environment' && /^align\*?$/.test(lens.env)) {
    return value.replace(/\\&/g, '&');
  }
  return value;
}

function ensureMathLiveElement() {
  const MathLive = window.MathLive;
  const MathfieldElement = MathLive?.MathfieldElement ?? window.MathfieldElement;
  if (MathfieldElement) {
    try {
      MathfieldElement.fontsDirectory = '/mathlive/fonts';
      MathfieldElement.soundsDirectory = null;
      MathfieldElement.keypressSound = null;
      MathfieldElement.plonkSound = null;
      MathfieldElement.keypressVibration = false;
    } catch {
      /* best effort */
    }
  }
  if (!customElements.get('math-field') && MathfieldElement) {
    try {
      customElements.define('math-field', MathfieldElement);
    } catch {
      /* already defined */
    }
  }
  return !!customElements.get('math-field');
}

function configureMathField(mathfield) {
  if (typeof mathfield.setOptions === 'function') {
    mathfield.setOptions({
      defaultMode: 'math',
      fontsDirectory: '/mathlive/fonts',
      locale: 'en',
      smartMode: false,
      smartFence: false,
      virtualKeyboardMode: 'manual',
      soundsDirectory: null,
      keypressSound: null,
      plonkSound: null,
    });
  }
}

function readMathFieldValue(mathfield) {
  if (typeof mathfield.getValue === 'function') {
    try {
      return mathfield.getValue('latex');
    } catch {
      /* fallback below */
    }
  }
  return typeof mathfield.value === 'string' ? mathfield.value : '';
}

function writeMathFieldValue(mathfield, value) {
  if (typeof mathfield.setValue === 'function') {
    try {
      mathfield.setValue(value);
      return;
    } catch {
      /* fallback below */
    }
  }
  mathfield.value = value;
}

function createMathKeyboardPanel(getMathfield) {
  const root = document.createElement('div');
  root.className = 'boxmath-keyboard';
  root.setAttribute('aria-label', '数式入力キーボード');

  const toolbar = document.createElement('div');
  toolbar.className = 'boxmath-keyboard-toolbar';
  const tabsEl = document.createElement('div');
  tabsEl.className = 'boxmath-keyboard-tabs';
  tabsEl.setAttribute('role', 'tablist');
  const shiftButton = document.createElement('button');
  shiftButton.type = 'button';
  shiftButton.className = 'boxmath-shift';
  shiftButton.textContent = 'Shift';
  shiftButton.setAttribute('aria-pressed', 'false');
  shiftButton.title = 'Shift バリアントを表示';
  toolbar.appendChild(tabsEl);
  toolbar.appendChild(shiftButton);

  const fixedGrid = document.createElement('div');
  fixedGrid.className = 'boxmath-fixed-grid';
  const grid = document.createElement('div');
  grid.className = 'boxmath-key-grid';
  const loading = document.createElement('div');
  loading.className = 'boxmath-keyboard-loading';
  loading.textContent = '数式キーを読み込み中…';

  root.appendChild(toolbar);
  root.appendChild(fixedGrid);
  root.appendChild(grid);
  root.appendChild(loading);

  const state = {
    activeTab: 'analysis',
    fixedKeys: [],
    sets: {},
    shiftHeld: false,
    shiftLocked: false,
    destroyed: false,
  };

  function availableTabs() {
    const known = MATH_KEYBOARD_TABS.filter((tab) => (state.sets[tab.id] ?? []).length > 0);
    const extras = Object.keys(state.sets)
      .filter((id) => !MATH_KEYBOARD_TABS.some((tab) => tab.id === id))
      .map((id) => ({ id, label: id }));
    return known.concat(extras);
  }

  function isShiftActive() {
    return state.shiftHeld || state.shiftLocked;
  }

  function renderTabs() {
    tabsEl.textContent = '';
    const tabs = availableTabs();
    for (const tab of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'boxmath-tab';
      button.textContent = tab.label;
      button.dataset.mathTab = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.id === state.activeTab ? 'true' : 'false');
      button.classList.toggle('is-active', tab.id === state.activeTab);
      button.addEventListener('mousedown', (ev) => ev.preventDefault());
      button.addEventListener('click', () => {
        state.activeTab = tab.id;
        renderAll();
      });
      tabsEl.appendChild(button);
    }
  }

  function renderAll() {
    if (state.destroyed) return;
    renderTabs();
    renderMathKeyboardKeys(fixedGrid, state.fixedKeys);
    renderMathKeyboardKeys(grid, state.sets[state.activeTab] ?? []);
    updateShiftButton();
  }

  function updateShiftButton() {
    const active = isShiftActive();
    shiftButton.classList.toggle('is-active', active);
    shiftButton.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function setShiftHeld(value) {
    if (state.shiftHeld === value) return;
    state.shiftHeld = value;
    renderAll();
  }

  function onWindowKeyDown(ev) {
    if (ev.key === 'Shift') setShiftHeld(true);
  }

  function onWindowKeyUp(ev) {
    if (ev.key === 'Shift') setShiftHeld(false);
  }

  function onWindowBlur() {
    setShiftHeld(false);
  }

  shiftButton.addEventListener('mousedown', (ev) => ev.preventDefault());
  shiftButton.addEventListener('click', () => {
    state.shiftLocked = !state.shiftLocked;
    renderAll();
  });

  window.addEventListener('keydown', onWindowKeyDown, true);
  window.addEventListener('keyup', onWindowKeyUp, true);
  window.addEventListener('blur', onWindowBlur);

  loadMathKeyboardData().then((data) => {
    if (state.destroyed) return;
    state.fixedKeys = data.mathKeyboardFixedKeys ?? [];
    state.sets = data.mathKeyboardSets ?? {};
    const tabs = availableTabs();
    if (!state.sets[state.activeTab]?.length && tabs[0]) state.activeTab = tabs[0].id;
    loading.remove();
    renderAll();
  });

  function renderMathKeyboardKeys(target, keys) {
    target.textContent = '';
    target.hidden = keys.length === 0;
    for (const rawKey of keys) {
      const key = resolveMathKeyboardKey(rawKey, isShiftActive());
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'boxmath-key';
      button.title = key.latex ?? key.label ?? '';
      if (key.latex) button.dataset.latex = key.latex;
      renderMathKeyLabel(button, key);
      if (!button.classList.contains('has-math')) {
        const length = Array.from(button.textContent ?? '').length;
        if (length > 4) button.classList.add('is-compact');
        if (length > 7) button.classList.add('is-tiny');
      }
      button.addEventListener('mousedown', (ev) => ev.preventDefault());
      button.addEventListener('click', () => insertMathKeyboardKey(getMathfield(), key));
      target.appendChild(button);
    }
  }

  return {
    el: root,
    destroy: () => {
      state.destroyed = true;
      window.removeEventListener('keydown', onWindowKeyDown, true);
      window.removeEventListener('keyup', onWindowKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
    },
  };
}

function resolveMathKeyboardKey(key, shiftActive) {
  if (!shiftActive) return key;
  const hasShift =
    key.shiftLabel ||
    key.shiftLatex ||
    key.shiftFallback ||
    key.shiftDisplayLatex ||
    key.shiftScriptKind ||
    key.shiftScriptValue !== undefined ||
    key.shiftScriptBase ||
    key.shiftScriptSubValue !== undefined ||
    key.shiftScriptSupValue !== undefined ||
    key.shiftTemplateKind ||
    key.shiftTemplateTarget !== undefined ||
    key.shiftTemplateSeparator !== undefined ||
    key.shiftTemplateScope !== undefined;
  if (!hasShift) return key;
  return {
    label: key.shiftLabel ?? key.label,
    latex: key.shiftLatex ?? key.latex,
    fallback: key.shiftFallback ?? key.fallback,
    displayLatex: key.shiftDisplayLatex ?? key.displayLatex,
    scriptKind: key.shiftScriptKind ?? key.scriptKind,
    scriptValue: key.shiftScriptValue !== undefined ? key.shiftScriptValue : key.scriptValue,
    scriptBase: key.shiftScriptBase ?? key.scriptBase,
    scriptSubValue: key.shiftScriptSubValue !== undefined ? key.shiftScriptSubValue : key.scriptSubValue,
    scriptSupValue: key.shiftScriptSupValue !== undefined ? key.shiftScriptSupValue : key.scriptSupValue,
    templateKind: key.shiftTemplateKind ?? key.templateKind,
    templateTarget: key.shiftTemplateTarget !== undefined ? key.shiftTemplateTarget : key.templateTarget,
    templateSeparator:
      key.shiftTemplateSeparator !== undefined ? key.shiftTemplateSeparator : key.templateSeparator,
    templateScope: key.shiftTemplateScope !== undefined ? key.shiftTemplateScope : key.templateScope,
  };
}

function renderMathKeyLabel(button, key) {
  const displayLatex = buildMathKeyDisplayLatex(key);
  const MathLive = window.MathLive;
  if (displayLatex && MathLive?.convertLatexToMarkup) {
    try {
      const wrapper = document.createElement('span');
      wrapper.className = 'boxmath-key-math';
      wrapper.innerHTML = MathLive.convertLatexToMarkup(`\\displaystyle ${displayLatex}`);
      button.textContent = '';
      button.appendChild(wrapper);
      button.classList.add('has-math');
      button.setAttribute('aria-label', key.label ?? displayLatex);
      return;
    } catch (err) {
      console.warn('MathLive render failed:', err);
    }
  }
  button.classList.remove('has-math');
  button.textContent = key.label ?? displayLatex ?? key.latex ?? '';
}

function buildMathKeyDisplayLatex(key) {
  const source = key.displayLatex ?? key.latex ?? key.fallback;
  if (!source) return null;
  const placeholders = ['x', 'y', 'z', 'a', 'b', 'c'];
  let index = 0;
  return source
    .replace(/#\?/g, () => placeholders[index++] ?? 'x')
    .replace(/\\placeholder\{\}/g, () => placeholders[index++] ?? 'x');
}

function insertMathKeyboardKey(mathfield, key) {
  if (!mathfield || (!key?.latex && !key?.fallback)) return;
  mathfield.focus?.();

  if (key.templateKind && typeof mathfield.getValue === 'function') {
    const selection = getMathFieldSelectionRange(mathfield);
    if (selection.start !== selection.end) {
      const selectedLatex = readMathFieldSelection(mathfield, selection);
      if (selectedLatex) {
        const builtLatex = buildTemplateWithSelectedLatex(key, selectedLatex);
        if (tryMathFieldInsert(mathfield, builtLatex, {
          selectionMode: 'placeholder',
          focus: true,
          feedback: false,
          format: 'latex',
        })) {
          return;
        }
      }
    }
  }

  if (
    !key.scriptKind &&
    !key.templateKind &&
    typeof key.latex === 'string' &&
    STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)
  ) {
    const selection = getMathFieldSelectionRange(mathfield);
    const selectedLatex = selection.start !== selection.end ? readMathFieldSelection(mathfield, selection) : null;
    const seed = selectedLatex && selectedLatex.length > 0 ? selectedLatex : '#?';
    const builtLatex = key.latex.replace(/#\?/g, seed);
    if (tryMathFieldInsert(mathfield, builtLatex, {
      selectionMode: selectedLatex ? 'after' : 'placeholder',
      focus: true,
      feedback: false,
      format: 'latex',
    })) {
      return;
    }
  }

  const insertValue = resolveMathInsertValue(key, { preserveTemplateMarkers: true });
  const fallbackInsertValue = resolveMathInsertValue(key, { preserveTemplateMarkers: false });
  if (!insertValue && !fallbackInsertValue) return;
  const hasTemplateMarkers = typeof key.latex === 'string' && key.latex.includes('#?');
  const insertOptions = {
    selectionMode: hasTemplateMarkers ? 'placeholder' : 'after',
    focus: true,
    feedback: false,
    format: 'latex',
  };
  if (tryMathFieldInsert(mathfield, insertValue, insertOptions)) return;
  if (
    fallbackInsertValue &&
    fallbackInsertValue !== insertValue &&
    tryMathFieldInsert(mathfield, fallbackInsertValue, {
      selectionMode: fallbackInsertValue.includes(MATH_PLACEHOLDER_LATEX) ? 'placeholder' : 'after',
      focus: true,
      feedback: false,
      format: 'latex',
    })
  ) {
    return;
  }
  console.warn('mathfield insertion failed:', key.latex ?? key.fallback);
}

function resolveMathInsertValue(key, options = {}) {
  const source = key.latex ?? key.fallback ?? '';
  if (options.preserveTemplateMarkers) return source;
  return source.replace(/#\?/g, MATH_PLACEHOLDER_LATEX);
}

function buildTemplateWithSelectedLatex(key, selectedLatex) {
  if (key.templateKind === 'wrap') {
    const parts = key.latex.split('#?');
    const placeholderCount = Math.max(0, parts.length - 1);
    const targetIndex =
      placeholderCount === 0
        ? null
        : Math.max(0, Math.min(key.templateTarget ?? 0, placeholderCount - 1));
    let built = parts[0] ?? '';
    for (let i = 0; i < placeholderCount; i++) {
      built += targetIndex !== null && i === targetIndex ? selectedLatex : '#?';
      built += parts[i + 1] ?? '';
    }
    return built;
  }
  return key.latex + (key.templateSeparator ?? '') + selectedLatex;
}

function getMathFieldSelectionRange(mathfield) {
  const selection = mathfield?.selection;
  if (Array.isArray(selection)) {
    if (selection.length === 2 && typeof selection[0] === 'number') {
      return { start: selection[0], end: selection[1] };
    }
    if (Array.isArray(selection[0])) {
      const [start, end] = selection[0];
      if (typeof start === 'number' && typeof end === 'number') return { start, end };
    }
  }
  if (selection?.ranges && Array.isArray(selection.ranges) && selection.ranges.length > 0) {
    const [start, end] = selection.ranges[0];
    if (typeof start === 'number' && typeof end === 'number') return { start, end };
  }
  if (typeof mathfield?.position === 'number') {
    return { start: mathfield.position, end: mathfield.position };
  }
  return { start: 0, end: 0 };
}

function readMathFieldSelection(mathfield, selection) {
  try {
    const value = mathfield.getValue(selection.start, selection.end, 'latex');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function tryMathFieldInsert(mathfield, latex, options) {
  if (!latex) return false;
  const before = typeof mathfield.getValue === 'function' ? readMathFieldValue(mathfield) : null;
  if (typeof mathfield.executeCommand === 'function') {
    try {
      const ok = mathfield.executeCommand('insert', latex, options);
      const after = typeof mathfield.getValue === 'function' ? readMathFieldValue(mathfield) : null;
      if (ok !== false || (before !== null && after !== null && after !== before)) {
        dispatchMathFieldInput(mathfield);
        return true;
      }
    } catch (err) {
      console.warn('executeCommand insert failed:', err);
    }
  }
  if (typeof mathfield.insert === 'function') {
    try {
      mathfield.insert(latex, options);
      const after = typeof mathfield.getValue === 'function' ? readMathFieldValue(mathfield) : null;
      if (before === null || after === null || after !== before) {
        dispatchMathFieldInput(mathfield);
        return true;
      }
    } catch {
      /* fallback below */
    }
  }
  return false;
}

function dispatchMathFieldInput(mathfield) {
  mathfield.dispatchEvent(new Event('input', { bubbles: true }));
}

function parseInlineMathLenses(source) {
  const lenses = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') {
      if (source[i + 1] === '(') {
        const end = findInlineParenMathEnd(source, i + 2);
        if (end >= 0) {
          const contentStart = i + 2;
          lenses.push({
            kind: 'inline',
            begin: '\\(',
            end: '\\)',
            outerStart: i,
            contentStart,
            contentEnd: end,
            outerEnd: end + 2,
            math: source.slice(contentStart, end),
          });
          i = end + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (source[i] === '$' && source[i + 1] !== '$' && source[i - 1] !== '$' && !isEscapedTexChar(source, i)) {
      const end = findInlineDollarMathEnd(source, i + 1);
      if (end >= 0) {
        const contentStart = i + 1;
        lenses.push({
          kind: 'inline',
          begin: '$',
          end: '$',
          outerStart: i,
          contentStart,
          contentEnd: end,
          outerEnd: end + 1,
          math: source.slice(contentStart, end),
        });
        i = end;
      }
    }
  }
  return lenses;
}

function findInlineParenMathEnd(source, start) {
  for (let i = start; i < source.length - 1; i++) {
    if (source[i] === '\\') {
      if (source[i + 1] === ')') return i;
      i++;
    }
  }
  return -1;
}

function findInlineDollarMathEnd(source, start) {
  for (let i = start; i < source.length; i++) {
    if (source[i] === '\n') return -1;
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === '$' && source[i + 1] !== '$' && source[i - 1] !== '$' && !isEscapedTexChar(source, i)) {
      return i;
    }
  }
  return -1;
}

function isEscapedTexChar(source, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function rebuildInlineMathBlockFromControls(lenses, textSegments, mathValues) {
  let out = '';
  lenses.forEach((lens, index) => {
    out += textSegments[index] ?? '';
    out += lens.begin;
    out += normalizeMathRowValue(mathValues[index] ?? lens.math, lens).trim();
    out += lens.end;
  });
  return out + (textSegments[lenses.length] ?? '');
}

function parseMathLens(source) {
  const envMatch = source.match(/^(\s*\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}\s*)([\s\S]*?)(\s*\\end\{\2\}\s*)$/);
  if (envMatch) {
    const body = envMatch[3];
    const label = body.match(/(^|\s)\\label\{([^{}]*)\}(\s|$)/);
    const labelText = label ? label[2] : null;
    const math = (label ? body.slice(0, label.index) + body.slice(label.index + label[0].length) : body).trim();
    return {
      kind: 'environment',
      env: envMatch[2],
      begin: envMatch[1],
      end: envMatch[4],
      label: labelText,
      math,
    };
  }

  const displayMatch = source.match(/^(\s*\\\[\s*)([\s\S]*?)(\s*\\\]\s*)$/);
  if (displayMatch) {
    return {
      kind: 'display',
      begin: displayMatch[1],
      end: displayMatch[3],
      label: null,
      math: displayMatch[2].trim(),
    };
  }

  const dollarMatch = source.match(/^(\s*\$\$?\s*)([\s\S]*?)(\s*\$\$?\s*)$/);
  if (dollarMatch && dollarMatch[1].trim() === dollarMatch[3].trim()) {
    return {
      kind: dollarMatch[1].trim() === '$' ? 'inline' : 'display',
      begin: dollarMatch[1],
      end: dollarMatch[3],
      label: null,
      math: dollarMatch[2].trim(),
    };
  }

  return null;
}

function rebuildMathLens(lens, values) {
  const math = values.math.trim();
  if (lens.kind === 'environment') {
    const lines = [lens.begin.trimEnd()];
    if (values.label !== null && values.label.trim()) lines.push(`  \\label{${values.label.trim()}}`);
    if (math) lines.push(...math.split('\n').map((line) => `  ${line}`));
    lines.push(lens.end.trimStart());
    return lines.join('\n');
  }
  if (lens.kind === 'inline') return `${lens.begin.trimEnd()}${math}${lens.end.trimStart()}`;
  return `${lens.begin.trimEnd()}\n${math}\n${lens.end.trimStart()}`;
}

function rebuildCommandLens(source, lens, values) {
  let out = '';
  let cursor = 0;
  for (let i = 0; i < lens.fields.length; i++) {
    const field = lens.fields[i];
    out += source.slice(cursor, field.start) + values[i];
    cursor = field.end;
  }
  return out + source.slice(cursor);
}

function parseCommandLens(source) {
  const fields = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;
    if (source[i] !== '\\') return null;
    const cmd = readCommandName(source, i);
    if (!cmd || !LENS_COMMANDS.has(cmd.name)) return null;
    i = cmd.end;
    if (source[i] === '*') i++;
    let argCount = 0;
    let sawBrace = false;
    while (i < source.length) {
      while (i < source.length && /[ \t]/.test(source[i])) i++;
      if (source[i] === '[') {
        const opt = readBalanced(source, i, '[', ']');
        if (!opt) return null;
        i = opt.end;
        continue;
      }
      if (source[i] !== '{') break;
      const arg = readBalanced(source, i, '{', '}');
      if (!arg) return null;
      fields.push({
        command: cmd.name,
        label: fieldLabel(cmd.name, argCount),
        start: arg.contentStart,
        end: arg.contentEnd,
        value: source.slice(arg.contentStart, arg.contentEnd),
      });
      sawBrace = true;
      argCount++;
      i = arg.end;
    }
    if (!sawBrace) return null;
  }
  return fields.length ? { fields } : null;
}

function readCommandName(source, start) {
  if (source[start] !== '\\') return null;
  let i = start + 1;
  if (!/[A-Za-z]/.test(source[i] ?? '')) return null;
  const nameStart = i;
  while (i < source.length && /[A-Za-z]/.test(source[i])) i++;
  return { name: source.slice(nameStart, i), end: i };
}

function readBalanced(source, start, open, close) {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return {
          contentStart: start + 1,
          contentEnd: i,
          end: i + 1,
        };
      }
    }
  }
  return null;
}

function fieldLabel(command, index) {
  const base = COMMAND_FIELD_LABELS[command] ?? command;
  return index === 0 ? base : `${base} ${index + 1}`;
}

function closeBox() {
  if (!boxState) return;
  const s = boxState;
  boxState = null;
  if (s.closing) clearTimeout(s.closing);
  s.editor.destroy?.();
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
  placeBoxEdit(s.wrap, rect);
  s.pageDiv = pageDiv;
}

function placeBoxEdit(wrap, rect) {
  const isMath = wrap.dataset.editorKind === 'math' || wrap.dataset.editorKind === 'word-math';
  const minWidth = isMath ? 80 : 42;
  const maxWidth = isMath ? 98 : 88;
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const left = Math.max(1, Math.min(rect.left, 99 - width));
  wrap.classList.toggle('is-column-edit', rect.width < 55);
  Object.assign(wrap.style, {
    left: left + '%',
    top: rect.top + '%',
    width: width + '%',
  });
}

// Template picker: start a fresh document from templates/*.tex
async function loadTemplateList(selectedId = '') {
  try {
    const list = await fetch('/templates').then((r) => r.json());
    const sel = templateSelectEl;
    if (!sel) return;
    sel.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'テンプレート';
    sel.appendChild(placeholder);
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.custom ? `カスタム: ${t.name}` : t.name;
      opt.title = t.desc;
      sel.appendChild(opt);
    }
    const demo = document.createElement('option');
    demo.value = '__demo';
    demo.textContent = 'デモ文書';
    sel.appendChild(demo);
    sel.value = selectedId && list.some((t) => t.id === selectedId) ? selectedId : '';
  } catch {
    /* templates are optional */
  }
}

templateSelectEl?.addEventListener('change', async (ev) => {
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
        highlightSelectedPreviewBlock();
        statusEl.textContent = `async preview #${msg.rev} [${backend}] — exact更新完了`;
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
            syncEditorHighlight();
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
