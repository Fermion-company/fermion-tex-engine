# Claude Handoff: Native hitboxes + environment-aware regions

Branch: `codex/page-layout-poc`. Follows `handoff/claude-page-layout-followup/`.
Local app target: `http://127.0.0.1:4633/` (launch.json `tdom`).

## What this pass did

### 1. Full-page exact hitboxes now come from native shipout instrumentation

The full-page exact preview no longer recovers edit hitboxes from `pdftotext -bbox`
word matching. `#fullPagePreview` now runs the existing `buildNativePageLayoutPoc`
instrumentation (a `pre_shipout_filter` Lua callback that tags **every glyph** with
the id of the block that produced it) and builds hitboxes from real per-block glyph
boxes (`#nativeFullPageHitboxes`).

- The SVG shown is rendered from the **same** instrumented PDF the glyph boxes came
  from, so hitboxes and image are in one coordinate frame.
- Coordinate frame (verified empirically, see `scratchpad/probe-coords.mjs` notes):
  `absolute page bp = glyph coordinate + 72` (the default 1in pdf origin). Glyph ink
  box = `[x, x+w] × [y-h, y+d]`.
- The Lua `emit_glyph` now also records glyph width/height/depth (`w`/`h`/`d`) so the
  box is exact rather than font-size-approximated.
- Fixes both failure modes of the old heuristic: short/common-word blocks used to get
  **no** box (or a word-sized one); wrong-page boxes are impossible now because
  attribution is per-glyph. Verified: `\section{Before/After/Tail}` all get tight,
  correctly-paged boxes.
- Page-break-only blocks (`\clearpage`, `\newpage`, `\onecolumn`…) are guarded by
  `blockHasVisibleText`: they set no ink, so any glyph tagged to them is the page
  footer/number the output routine emitted while their start marker was active.
  Dropping those avoids a stray hitbox over the page number.
- **Fallback preserved**: if the native capture is unavailable (no fork shim,
  instrumentation compile error), it falls back to the original pdftotext path,
  unchanged. `#assembleFullPagePages` is the shared SVG/DL assembly for both.

### 2. Environment-aware source tree (owner/continuation model)

Column environments (`paracol` / `multicols`) stay a **single atomic block** for
typesetting — the resident daemon always receives the whole, compilable environment,
never a fragment. On top of that owner we expose independently editable **child
regions**: each heading/paragraph inside the environment, tagged with its column.

- `environmentChildren(block)` (engine-v3.js) splits the environment body with the
  same `segmentBody` used at top level, assigns paracol columns from `\switchcolumn`
  boundaries (multicols columns are resolved from glyph x at hitbox time), and skips
  structural-only segments (`\switchcolumn`).
- Children are attached to `block.children` on every update and inside
  `buildNativePageLayoutPoc`. `instrumentBlockRegions` splices `\special{tdom:poc:
  rstart/rend:<regionId>}` markers so glyphs come back `region`-tagged.
- `getDOM()` exposes a new top-level `regions: [...]` array (kept **out of** `blocks`
  so the outline/structure stay owner-grained). Each region carries `id`, `owner`,
  `type`, `column`, `layout`, `source`, `span`.
- Native hitboxes for a region use `src = regionId`, `owner = blockId`, plus
  `column`/`layout`, so each child is independently targetable and column-tight.
- **Editing is inherently safe**: a region hitbox opens an editor scoped to the
  region's `span`; committing rewrites just that slice, which changes the owner
  block's text, which re-typesets the whole environment. No partial TeX ever reaches
  the daemon. Verified in-browser: clicking `\subsection{Left Stream}` opens a scoped
  subsection editor; renaming it kept `\begin{paracol}…\end{paracol}` intact.
- Frontend wiring is minimal: `editableNode(dom, src)` consults `blocks` then
  `regions`; `workspaceRegions` lets the preview insert-button target regions.

### 3. Live-draft vs exact-preview UI state

A small badge (`#preview-state`) in the Preview pane title:
- `下書き · 正確なページを生成中…` while the resident live draft shows and the exact
  page is rebuilding async (`fullPagePreviewPending`).
- `正確なページに更新` flashes when the async exact render swaps in, then auto-hides
  after 2.5s.
- Hidden for ordinary (non-full-page) documents. Driven from the same
  `fullPagePreviewPending` stat + the `async full-page preview:` SSE report, so it
  stays consistent with the existing status line (which still shows `exact更新中` /
  `exact更新完了`).

## Verified

- `npm test`: 44/44 (was 42; added `native shipout hitboxes cover short blocks and
  skip page-break blocks` and `paracol exposes independently editable, column-tagged
  child regions`).
- Browser (paracol + `\twocolumn` + `\onecolumn` doc, localhost):
  - Edits patch the preview with no reload; live draft → exact swap observed
    (badge `下書き` → `正確なページに更新` → hidden), page count stable, no stale pages.
  - `After Paracol` hitboxes stay on page 1 (do not leak past the following
    `\clearpage`).
  - Two-column zone hitboxes only on page 2; no stray boxes around
    `\twocolumn`/`\onecolumn` (those command-only blocks get no hitbox).
  - `\subsection{Left Stream/Right Stream}` render with natural TeX top-spacing
    (it *is* real lualatex output now).
  - Region edit (`Left Stream` → `Left Channel`) kept the owner environment whole;
    server source matched client; resident daemon got no broken fragment.
  - No browser console errors, no server errors.

## Remaining / suspicious

1. **Native path is heavier than pdftotext.** It does 2 lualatex passes with
   instrumentation + per-page fork snapshots. The `open` path calls `#fullPagePreview`
   synchronously, so opening a full-page-exact document is a bit slower than before;
   on *edit* it is async behind the live draft, so the cold ~2–4s exact render is
   hidden. If open latency matters, consider caching the shim/first pass or making the
   very first exact render async too.
2. **Footer/continuation mis-attribution (partial).** `blockHasVisibleText` only
   guards *command-only* blocks. A real text block (or region) that spans a page break
   stays the active block through that page's footer, so its box can extend slightly
   to include the page number. Not observed as harmful in tests, but a per-glyph
   header/footer filter (drop glyphs outside the text area computed from geometry)
   would be the clean fix.
3. **Coordinate origin constant.** Hitboxes assume the default pdf origin
   (`\pdfhorigin`/`\pdfvorigin` = 1in ⇒ +72bp). Documents that set `\hoffset`/
   `\voffset` or a non-default origin would shift boxes. The `geometry` package
   normally leaves the pdf origin at 1in, so this holds for the common case; capture
   the origin from the run if a counterexample appears.
4. **multicols region columns are glyph-derived.** Unlike paracol (static columns via
   `\switchcolumn`), a multicols child region's column comes from clustering its own
   glyph x into `cols` bands. A region that straddles a column break emits one box per
   column. Correct, but less crisp than paracol.
5. **Region ids are positional** (`<blockId>.r<n>`, recomputed each update). Stable
   while the block id and segment order are stable; inserting/removing a paragraph
   inside the environment renumbers later regions. The inline region editor is
   short-lived so this has not caused stale-target issues, but a longer-lived region
   reference should not assume id stability across structural edits.
6. **`.chip.page` vs `#pages > .page`.** When inspecting the preview, scope page
   queries to `#pages > .page`; the workspace panels also render `<span class="chip
   page">page N</span>` badges that a bare `.page` selector will match (this cost time
   during verification — it looked like stale empty pages but was not).

## Task for Fable tomorrow

Live preview becomes extremely slow when the document contains two-column layout.
Investigate the cause and choose one of these fixes:

1. If there is an algorithmic way to make the live preview fundamentally faster,
   migrate to that approach.
2. If there is no practical fast path, show an intermediate preview state first and
   then render the correct preview asynchronously with delay.

## Touch points

- `engine/checkpoint/engine-v3.js`: `#fullPagePreview`, `#assembleFullPagePages`,
  `#nativeFullPageHitboxes`, `#childRegions`, `environmentChildren`,
  `instrumentBlockRegions`, `blockHasVisibleText`, Lua `emit_glyph`/`check_marker`
  region tracking, `getDOM().regions`, child attach in `#update` +
  `buildNativePageLayoutPoc`.
- `web/app.js`: `previewStateEl` + `setPreviewState`, `editableNode`,
  `workspaceRegions`, `insertTexAtTarget`, SSE async handler.
- `web/index.html`, `web/style.css`: `#preview-state` badge.
- `tests/engine-v3.test.js`: two new tests.
