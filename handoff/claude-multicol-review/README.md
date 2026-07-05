# Claude handoff: multicol preview and UI

## Goal

Review the multicol implementation added in this session for correctness and safety, then improve or add tests if needed.

The user wanted:

- `multicols` 3+ columns to work.
- Both `multicols` and `multicols*` to be verified.
- A UI that lets users choose column count and flow behavior without writing TeX environment syntax directly.
- A mechanism that can be extended later to similar multi-column environments, while accepting a focused `multicol` implementation for now.

## Changed files

- `engine/checkpoint/engine-v3.js`
- `server.js`
- `tests/engine-v3.test.js`
- `web/index.html`
- `web/app.js`

## Implementation summary

- `multicols` and `multicols*` block detection now captures the environment name and star form.
- Resident multicol preview supports 3+ columns for the cases that are stable in the checkpoint engine.
- Normal `multicols` with 4 or more columns now uses full-page exact preview instead of the resident output-routine path. The resident path was observed to hit TeX output-routine failures or long-running dead-cycle behavior for this case.
- Detection scans all normal `multicols` blocks, not just the first one, so a later 4-column block is not hidden by an earlier 3-column block.
- Async full-page exact preview now emits a normal `update` report with `fullPagePreviewPending:false` when it completes, so `/doc` and the Inspector do not remain stuck in a pending state.
- The web UI adds a "多段組" insert card:
  - Column count select: 2-6 columns.
  - Flow select:
    - `最後の段を揃える` => `multicols`
    - `順に流す` => `multicols*`
  - Target selector, optional heading, body textarea, and insert button.
  - Insertion ensures `\usepackage{multicol}`.
  - The optional heading is emitted before the multicol environment, not inside it. This avoids the real `multicols*` behavior where later columns can start at the same vertical band as an over-wide heading in the first column.

## Known design tradeoff

Normal `multicols` with 4+ columns is exact-preview fallback, not resident editable glyph layout. This is deliberate because the resident TeX output routine was not stable for that case. The resulting preview still has page-level display lists and hitboxes from the exact preview path, but it does not have the same fine-grained resident multicol glyph semantics as stable resident cases.

`multicols*` with 4 columns remains on the resident path and was verified with hitboxes in columns 0, 1, 2, and 3 when the body is long enough.

## Latest user-reported defect

The user provided a screenshot where a multicol heading and column text overlapped vertically. Investigation showed that the UI-generated `\section{...}` had been placed inside `multicols*`. That is valid TeX, but in starred multicols later columns can start in the same vertical band as a wide first-column heading, so the preview looked like the column start point was shifted upward and text was colliding with the heading.

The UI now emits the optional heading before the multicol environment:

```tex
\section{Title}
\begin{multicols*}{4}
...
\end{multicols*}
```

Do not move the generated heading back inside `multicols` / `multicols*` unless the UX is changed to explain that it is a column-local heading.

## Verification already run

- `node --test tests/engine-v3.test.js`
- `npm test`
- Browser UI verification on `http://127.0.0.1:4633/`:
  - Inserted 4-column `multicols`; verified `\begin{multicols}{4}`, exact full-page preview chunks, and async completion report.
  - Inserted 4-column `multicols*`; verified `\begin{multicols*}{4}`, `fullPagePreview:false`, and resident multicol hitboxes with columns 0-3 using a longer body.

## Suggested review focus

- Confirm the early full-page preview branch in `CheckpointEngine.#update` returns all report fields expected by the web UI and server API.
- Check whether the synthetic async report timings should be zero, omitted, or measured.
- Check whether exact-preview hitbox behavior for 4+ normal `multicols` is acceptable for editing UX.
- Confirm that the `fullPagePreviewReason` scan intentionally ignores `multicols*` 4+ columns.
- Consider whether the UI should allow more than 6 columns even though the engine clamps to 20.
- Confirm the heading-outside-environment behavior matches the intended UX for "見出し".
- Add a browser-level regression if the project gains UI test infrastructure: insert `4段` + `順に流す` + heading, then assert the first multicol glyph starts below the heading glyph band.
- Consider changing the generic SSE `patches` status text because exact-render chunks from non-full-page paths can also show `exact更新完了`.
