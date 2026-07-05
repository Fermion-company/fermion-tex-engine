# Claude Handoff: Page Layout Follow-up

## Current state

- Branch: `codex/page-layout-poc`
- Local app target: `http://127.0.0.1:4634/`
- Implemented in this pass:
  - Full-page exact documents no longer keep a stale image on edit. Edits now return a resident live preview patch immediately, while exact full-page rendering is queued asynchronously.
  - Top-level heading commands are standalone edit blocks for `\part`, `\chapter`, `\section`, `\subsection`, and `\subsubsection`.
  - Headings inside command optional arguments, especially `\twocolumn[...]`, are intentionally kept inside the owning block so the resident live preview does not send invalid partial TeX to the daemon.
  - Full-page hitbox recovery now prefers unique terms, skips unreliable short/common blocks, and uses nearby `\clearpage` / `\twocolumn` / `\onecolumn` commands as page lower/upper bounds.
  - The current localhost paracol/twocolumn smoke document shows:
    - `After paracol...` hitbox only on page 1.
    - twocolumn body hitboxes only on page 2.
    - after-onecolumn hitboxes only on page 3.

## Remaining or suspicious areas

1. Full-page hitboxes are still heuristic.
   - They are reconstructed from `pdftotext -bbox` words.
   - Short headings or text with only common terms may intentionally get no preview hitbox rather than a wrong one.
   - Better long-term fix: use the native page-layout PoC instrumentation or SyncTeX/specials to map block ids to shipped page boxes.

2. Environment contents are still mostly atomic edit blocks.
   - Top-level headings are split, but headings inside environments such as `paracol` remain inside the environment block.
   - Splitting inside environments needs an owner/continuation model so each child edit still compiles with the surrounding environment context.

3. `\twocolumn[...]` is deliberately not split internally.
   - This avoids invalid partial TeX in the resident live path.
   - If headings inside optional top matter must become independent edit cards, implement structured command-argument segmentation rather than line-based splitting.

4. Live preview during full-page exact documents is a draft.
   - The immediate patch comes from the resident path and can temporarily have a different page count or geometry.
   - The exact normal-TeX full-page render replaces it asynchronously.
   - UI may need a visible "live draft / exact updating" state if this distinction should be explicit.

5. Some valid hitboxes are small.
   - Because unique-term matching avoids false positives, blocks like short after-column paragraphs may get a word-sized box.
   - This is preferable to wrong-page boxes, but not ideal for editing ergonomics.

## Suggested next steps

1. Replace PDF word matching with native block/page box capture in the full-page exact path.
2. Add an environment-aware source tree so `paracol` / `multicols` can expose child headings safely.
3. Add UI state for live-draft versus exact-preview completion.
4. Add browser regression checks for:
   - Editing text in a full-page exact document visibly patches before async exact completes.
   - `After paracol...` does not create any hitbox after the following `\clearpage`.
   - `\twocolumn[...]` top matter does not get split into invalid resident blocks.
