# Verification notes

## Automated tests

```sh
node --test tests/engine-v3.test.js
npm test
```

Results from this session:

- `tests/engine-v3.test.js`: 16 passed.
- Full suite via `npm test`: 36 passed.

## New tests added

- `multicols variants handle three or more columns`
  - Verifies:
    - `multicols` 3 columns uses resident preview.
    - `multicols` 4 columns uses exact full-page preview.
    - `multicols*` 3 columns uses resident preview.
    - `multicols*` 4 columns uses resident preview.
  - Checks pagination, hitbox bounds, resident multicol glyphs for resident cases, and exact chunks for fallback cases.

- `full-page preview detection sees later four-column multicols blocks`
  - Verifies that a later `\begin{multicols}{4}` is detected even if an earlier `\begin{multicols}{3}` appears first.
  - Verifies the exact preview report shape includes `dirtySourceNodes` and `dirtyDependencies`.

## Manual browser checks performed

Server:

```sh
npm start
```

Browser:

- Opened `http://127.0.0.1:4633/`.
- Opened the `追加` panel.
- Used the new `多段組` card.

Normal 4-column check:

- Selected `4段`.
- Selected `最後の段を揃える`.
- Inserted a long body.
- Confirmed source contained `\begin{multicols}{4}`.
- Confirmed async full-page exact preview completed.
- Confirmed `/doc` showed:
  - `fullPagePreview: true`
  - `fullPagePreviewReason: "multicols environment with 4+ columns"`
  - `fullPagePreviewPending: false`

Starred 4-column check:

- Reset document.
- Selected `4段`.
- Selected `順に流す`.
- Inserted a long body.
- Confirmed source contained `\begin{multicols*}{4}` and not `\begin{multicols}{4}`.
- Confirmed the optional heading is emitted before `\begin{multicols*}{4}`.
- Confirmed `/doc` showed:
  - `fullPagePreview: false`
  - `fullPagePreviewReason: ""`
  - `fullPagePreviewPending: false`
- Confirmed resident multicol hitboxes included columns `0`, `1`, `2`, and `3`.
- Confirmed preview glyph positions put the heading on page 2 at `y=505.35` and the first multicol text at `y=529.26`, so the text no longer starts in the heading band.

## Reproduction case that motivated a fix

The first detector implementation used `text.match(...)`, so it only examined the first normal `multicols` block. In a document with a 3-column block first and a 4-column block later, the 4-column fallback was skipped.

The detector now uses `matchAll(...)` and returns fallback if any normal `multicols` block has 4 or more columns.

## Review questions for Claude

- Is the exact fallback threshold for normal `multicols` best set at `>= 4`, or should it depend on body size, page breaks, or observed TeX failure?
- Should async full-page exact preview reports include measured render time rather than zero-valued phase timings?
- Should the web UI expose an "advanced" column count input beyond the 2-6 select?
- Should 4+ normal `multicols` still expose coarser edit hitboxes differently to make the exact fallback UX clearer?
- Should the heading-outside-environment behavior be documented in the UI, or is the current "見出し" field clear enough?
