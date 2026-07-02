// Source segmenter — builds the top level of the Source DOM.
//
// The body of the document is split into blocks: the incremental unit of the
// whole pipeline. A block is a paragraph, a heading, a display-math span, or
// an entire environment. Boundaries are:
//   - blank lines at group/environment depth 0
//   - lines starting with \section / \subsection / \begin{...} / \[  (depth 0)
//   - the line where an environment or display math closes
//
// Blank lines *inside* an environment or display math do not split.
//
// segmentBody() is a linear scan over the body text — trivial arithmetic per
// keystroke. Everything expensive downstream (expansion, semantics, layout)
// is cached per block, so this scan is what keeps block identity honest.

import { fnv1a } from './hash.js';

const FORCED_START = /^\s*(\\section\b|\\subsection\b|\\begin\{|\\\[)/;

export function segmentBody(text, baseOffset) {
  const segs = [];
  const lines = splitLines(text);
  let envDepth = 0;
  let braceDepth = 0;
  let inDisplay = false;
  let cur = null; // { start, end }

  const flush = (endOffset) => {
    if (cur !== null) {
      const raw = text.slice(cur.start, endOffset);
      if (raw.trim().length > 0) {
        segs.push({ start: baseOffset + cur.start, end: baseOffset + endOffset, text: raw });
      }
      cur = null;
    }
  };

  for (const ln of lines) {
    const stripped = stripComment(ln.text);
    const blank = stripped.trim().length === 0 && ln.text.trim().length === 0;
    const atTop = envDepth === 0 && braceDepth <= 0 && !inDisplay;

    if (blank && atTop) {
      flush(ln.start);
      continue;
    }
    if (atTop && cur !== null && FORCED_START.test(stripped)) {
      flush(ln.start);
    }
    if (cur === null && !blank) cur = { start: ln.start };

    // Track depth transitions on this line.
    envDepth += countMatches(stripped, /\\begin\{[^}]*\}/g);
    envDepth -= countMatches(stripped, /\\end\{[^}]*\}/g);
    if (envDepth < 0) envDepth = 0;
    if (/\\\[/.test(stripped)) inDisplay = true;
    if (/\\\]/.test(stripped)) inDisplay = false;
    braceDepth += braceDelta(stripped);
    if (braceDepth < 0) braceDepth = 0;

    // Environment / display math closed on this line at depth 0: block ends here.
    if (cur !== null && envDepth === 0 && !inDisplay && braceDepth <= 0) {
      if (/\\end\{[^}]*\}\s*$/.test(stripped) || /\\\]\s*$/.test(stripped)) {
        flush(ln.end);
      }
    }
  }
  flush(text.length);

  for (const s of segs) s.hash = fnv1a(s.text);
  return segs;
}

/**
 * Locate the preamble/body split. Returns
 * { preamble:{start,end}, body:{start,end} }. If \begin{document} is missing
 * the whole file is treated as body (keeps the engine alive mid-edit).
 */
export function documentBounds(text) {
  const b = text.indexOf('\\begin{document}');
  if (b < 0) {
    return { preamble: { start: 0, end: 0 }, body: { start: 0, end: text.length } };
  }
  const bodyStart = b + '\\begin{document}'.length;
  const e = text.indexOf('\\end{document}', bodyStart);
  const bodyEnd = e < 0 ? text.length : e;
  return { preamble: { start: 0, end: b }, body: { start: bodyStart, end: bodyEnd } };
}

/**
 * Diff old blocks vs new segments by content hash. Reuses block objects for
 * unchanged content (preserving expansion/layout caches by identity), reuses
 * ids for positionally-paired modified blocks, and mints new ids otherwise.
 *
 * Returns { blocks, dirty: Set<blockId>, added: [id], removed: [id] }.
 */
export function diffBlocks(oldBlocks, segs, nextId) {
  const nOld = oldBlocks.length;
  const nNew = segs.length;
  let p = 0;
  while (p < nOld && p < nNew && oldBlocks[p].hash === segs[p].hash) p++;
  let so = nOld;
  let sn = nNew;
  while (so > p && sn > p && oldBlocks[so - 1].hash === segs[sn - 1].hash) {
    so--;
    sn--;
  }

  const blocks = [];
  const dirty = new Set();
  const added = [];
  const removed = [];

  // Common prefix: reuse objects, refresh offsets.
  for (let i = 0; i < p; i++) {
    blocks.push(refresh(oldBlocks[i], segs[i]));
  }
  // Middle: pair positionally.
  const midOld = so - p;
  const midNew = sn - p;
  const shared = Math.min(midOld, midNew);
  for (let i = 0; i < shared; i++) {
    const ob = oldBlocks[p + i];
    const sg = segs[p + i];
    if (ob.hash === sg.hash) {
      blocks.push(refresh(ob, sg));
    } else {
      // Modified in place: keep the id. Expansion/semantics must rebuild
      // (they depend on the text), but the layout cache is carried over —
      // the layout key decides whether the rebuilt semantics differ.
      const nb = {
        id: ob.id,
        start: sg.start,
        end: sg.end,
        text: sg.text,
        hash: sg.hash,
        sem: null,
        exp: null,
        layout: ob.layout,
        layoutKey: ob.layoutKey,
      };
      blocks.push(nb);
      dirty.add(nb.id);
    }
  }
  for (let i = shared; i < midNew; i++) {
    const sg = segs[p + i];
    const id = 'b' + nextId();
    blocks.push({
      id,
      start: sg.start,
      end: sg.end,
      text: sg.text,
      hash: sg.hash,
      sem: null,
      exp: null,
      layout: null,
      layoutKey: null,
    });
    dirty.add(id);
    added.push(id);
  }
  for (let i = shared; i < midOld; i++) removed.push(oldBlocks[p + i].id);
  // Common suffix.
  for (let i = 0; i < nNew - sn; i++) {
    blocks.push(refresh(oldBlocks[so + i], segs[sn + i]));
  }

  return { blocks, dirty, added, removed };
}

function refresh(block, seg) {
  block.start = seg.start;
  block.end = seg.end;
  return block;
}

function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function countMatches(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

function braceDelta(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '{' || c === '}') && (i === 0 || s[i - 1] !== '\\')) {
      d += c === '{' ? 1 : -1;
    }
  }
  return d;
}
