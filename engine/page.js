// Page DOM — incremental pagination.
//
// Input is the flattened stream of line units (owned by layout nodes; the
// unit objects for unchanged blocks are reference-identical to the previous
// run). Pages are greedy chunks of that stream. Because a page always starts
// at vertical position 0, two runs that start a page at the same unit object
// will break all subsequent pages identically — that fact powers both the
// convergence check and page reuse:
//
//   - pages whose unit sequence is reference-equal to last run's page at the
//     same number are reused wholesale (display list untouched, no patch)
//   - after an insertion/deletion, as soon as a new page starts at a unit
//     that also started an old page (and no dirty layout remains beyond),
//     the old pages are adopted and only renumbered if needed.

import { PAGE } from './layout.js';

/**
 * Chunk the unit stream into pages.
 * Returns array of pages: { number, units: [{u, y}], startUnit }.
 * contentHeight defaults to the internal engine's page geometry; the LuaTeX
 * backend passes the probed \textheight instead.
 */
export function paginate(stream, contentHeight = PAGE.textHeight) {
  const pages = [];
  let cur = [];
  let y = 0;
  let pending = []; // units held back for keepWithNext (headings)

  const H = contentHeight;

  const closePage = () => {
    pages.push({ number: pages.length + 1, units: cur, startUnit: cur[0]?.u ?? null });
    cur = [];
    y = 0;
  };

  const place = (u) => {
    const pre = cur.length === 0 ? 0 : u.pre; // vertical space discards at page top
    const need = pre + u.h;
    if (cur.length > 0 && y + need > H) {
      closePage();
      cur.push({ u, y: u.h - u.ln.descent });
      y = u.h + u.post;
    } else {
      cur.push({ u, y: y + pre + u.h - u.ln.descent });
      y += need + u.post;
    }
  };

  for (const u of stream) {
    if (u.keepWithNext) {
      pending.push(u);
      continue;
    }
    if (pending.length) {
      // ensure heading + first following line fit together
      const groupH = pending.reduce((s, p) => s + (cur.length === 0 ? 0 : p.pre) + p.h + p.post, 0) + u.pre + u.h;
      if (cur.length > 0 && y + groupH > H) closePage();
      for (const p of pending) place(p);
      pending = [];
    }
    place(u);
  }
  for (const p of pending) place(p);
  if (cur.length) closePage();
  if (!pages.length) pages.push({ number: 1, units: [], startUnit: null });
  return pages;
}

/**
 * Compare new pages against previous pages and reuse untouched page objects
 * (so their display lists survive by identity).
 * Returns { pages, reused, rebuilt } where reused counts pages adopted from
 * the previous run without display-list regeneration.
 */
export function reconcilePages(newPages, oldPages) {
  let reused = 0;
  const pages = newPages.map((np) => {
    const op = oldPages[np.number - 1];
    if (op && op.number === np.number && sameUnits(op.units, np.units)) {
      reused++;
      return op; // keeps op.dl / op.hash
    }
    return np;
  });
  return { pages, reused, rebuilt: pages.length - reused };
}

function sameUnits(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].u !== b[i].u || a[i].y !== b[i].y) return false;
  }
  return true;
}
