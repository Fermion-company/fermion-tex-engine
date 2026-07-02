// Layout DOM — turns semantic nodes into positioned line boxes.
//
// Paragraphs go through glue/box line breaking with justification: every
// word is a rigid box, every interword gap is stretchable/shrinkable glue.
// CJK characters become individual boxes joined by zero-width breakable glue
// so Japanese text wraps correctly.
//
// A layout node owns its `units` (one per line) — these objects are what the
// paginator and the convergence check hold by reference, so an unchanged
// paragraph contributes literally the same line objects to the next
// pagination pass.

import { measure, spaceGlue, isCJK } from './metrics.js';
import { layoutMath } from './math-layout.js';

export const PAGE = {
  width: 612,
  height: 792,
  marginX: 96,
  marginTop: 96,
  marginBottom: 96,
  get textWidth() {
    return this.width - 2 * this.marginX;
  },
  get textHeight() {
    return this.height - this.marginTop - this.marginBottom;
  },
};

export const STYLE = {
  fontSize: 10,
  leading: 12.5,
  parindent: 15,
  parskip: 3,
  section: { size: 14.4, leading: 17.5, before: 20, after: 10 },
  subsection: { size: 12, leading: 14.5, before: 14, after: 7 },
  subsubsection: { size: 10, leading: 12.5, before: 10, after: 5 },
  listIndent: 18,
  mathPad: 7,
};

/**
 * Lay out one semantic node.
 * refsResolver: (key) => display text for \ref.
 * indent: whether the paragraph gets a first-line indent.
 */
export function layoutBlock(sem, { indent, refsResolver }) {
  switch (sem.type) {
    case 'section':
      return layoutHeading(sem, refsResolver);
    case 'paragraph':
      return layoutParagraph(sem, indent, refsResolver);
    case 'displaymath':
      return layoutDisplayMath(sem);
    case 'list':
      return layoutList(sem, refsResolver);
    default:
      return layoutParagraph({ ...sem, runs: [], type: 'paragraph' }, false, refsResolver);
  }
}

// ------------------------------------------------------------- paragraphs

function runsToItems(runs, size, refsResolver, extraStyle = {}) {
  const items = [];
  for (const run of runs) {
    if (run.kind === 'math') {
      const m = layoutMath(run.ast, size);
      items.push({ type: 'box', w: m.w, asc: m.asc, desc: m.desc, math: m.runs, size });
      continue;
    }
    if (run.kind === 'ref') {
      const text = refsResolver ? refsResolver(run.key) : '??';
      const style = { ...run.style, ...extraStyle };
      items.push({ type: 'box', w: measure(text, style, size), text, style, size });
      continue;
    }
    // text run: split into words / CJK char boxes / glue
    const style = { ...run.style, ...extraStyle };
    const glue = spaceGlue(style, size);
    const text = run.text;
    let word = '';
    const flushWord = () => {
      if (!word) return;
      items.push({ type: 'box', w: measure(word, style, size), text: word, style, size });
      word = '';
    };
    for (const ch of text) {
      if (ch === ' ') {
        flushWord();
        const prev = items[items.length - 1];
        if (prev && prev.type !== 'glue') {
          items.push({ type: 'glue', w: glue.w, stretch: glue.stretch, shrink: glue.shrink });
        }
      } else if (ch === ' ') {
        word += ' '; // tie: stays inside the box
      } else if (isCJK(ch)) {
        flushWord();
        // breakable zero-width join before a CJK box (unless line start)
        const prev = items[items.length - 1];
        if (prev && prev.type === 'box') {
          items.push({ type: 'glue', w: 0, stretch: glue.stretch * 0.5, shrink: 0, cjk: true });
        }
        items.push({ type: 'box', w: measure(ch, style, size), text: ch, style, size });
      } else {
        word += ch;
      }
    }
    flushWord();
  }
  // trim leading/trailing glue
  while (items.length && items[0].type === 'glue') items.shift();
  while (items.length && items[items.length - 1].type === 'glue') items.pop();
  return items;
}

/**
 * Greedy justified line breaking.
 * Returns array of lines: { runs, w, ascent, descent, h }.
 */
function breakLines(items, firstWidth, restWidth, leading, { justify = true, indentX = 0, restIndentX = 0 } = {}) {
  const lines = [];
  let cur = [];
  let curW = 0;
  let lineNo = 0;

  const target = () => (lineNo === 0 ? firstWidth : restWidth);

  const emit = (isLast) => {
    // drop trailing glue
    while (cur.length && cur[cur.length - 1].type === 'glue') {
      curW -= cur[cur.length - 1].w;
      cur.pop();
    }
    if (!cur.length) return;
    const tw = target();
    const glues = cur.filter((it) => it.type === 'glue');
    let extra = tw - curW;
    let perGlue = () => 0;
    if (justify && !isLast && glues.length > 0) {
      const totalStretch = glues.reduce((s, g) => s + (g.stretch || 0), 0) || 1;
      const totalShrink = glues.reduce((s, g) => s + (g.shrink || 0), 0) || 1;
      if (extra >= 0) perGlue = (g) => ((g.stretch || 0) / totalStretch) * extra;
      else perGlue = (g) => ((g.shrink || 0) / totalShrink) * extra;
    }
    // position boxes
    const runs = [];
    let x = lineNo === 0 ? indentX : restIndentX;
    let ascent = leading * 0.72;
    let descent = leading * 0.28;
    for (const it of cur) {
      if (it.type === 'glue') {
        x += it.w + perGlue(it);
        continue;
      }
      if (it.math) {
        for (const r of it.math) {
          if (r.rule) runs.push({ rule: true, x: x + r.x, dy: r.dy, w: r.w, h: r.h });
          else runs.push({ text: r.text, x: x + r.x, dy: r.dy, size: r.size, style: { i: r.it ? 1 : 0, b: 0, tt: 0 } });
        }
        ascent = Math.max(ascent, it.asc);
        descent = Math.max(descent, it.desc);
      } else {
        runs.push({ text: it.text, x, dy: 0, size: it.size, style: it.style });
      }
      x += it.w;
    }
    const h = Math.max(leading, ascent + descent + 1.5);
    lines.push({ runs, w: x, ascent, descent, h });
    cur = [];
    curW = 0;
    lineNo++;
  };

  for (const it of items) {
    if (it.type === 'glue') {
      if (cur.length === 0) continue;
      cur.push(it);
      curW += it.w;
      continue;
    }
    const wouldBe = curW + it.w;
    // allow shrink: only break if even max shrink cannot fit
    const shrinkable = cur.filter((g) => g.type === 'glue').reduce((s, g) => s + (g.shrink || 0), 0);
    if (cur.length > 0 && wouldBe > target() + shrinkable) {
      emit(false);
    }
    cur.push(it);
    curW += it.w;
  }
  emit(true);
  return lines;
}

function layoutParagraph(sem, indent, refsResolver) {
  const size = STYLE.fontSize;
  const items = runsToItems(sem.runs, size, refsResolver);
  const width = PAGE.textWidth;
  const indentX = indent && !sem.centered ? STYLE.parindent : 0;
  let lines = breakLines(items, width - indentX, width, STYLE.leading, {
    justify: !sem.centered,
    indentX,
    restIndentX: 0,
  });
  if (sem.centered) {
    lines = lines.map((ln) => {
      const shift = Math.max(0, (width - ln.w) / 2);
      return { ...ln, runs: ln.runs.map((r) => ({ ...r, x: r.x + shift })) };
    });
  }
  return makeLayoutNode(sem, lines, STYLE.parskip * 0.5, STYLE.parskip * 0.5);
}

function layoutHeading(sem, refsResolver) {
  const cfg = sem.level === 1 ? STYLE.section : sem.level === 2 ? STYLE.subsection : STYLE.subsubsection;
  const style = { i: 0, b: 1, tt: 0 };
  const prefix = sem.number ? sem.number + ' ' : '';
  const items = [];
  if (prefix) {
    items.push({ type: 'box', w: measure(prefix, style, cfg.size), text: prefix, style, size: cfg.size });
  }
  items.push(...runsToItems(sem.titleRuns, cfg.size, refsResolver, { b: 1 }));
  const lines = breakLines(items, PAGE.textWidth, PAGE.textWidth, cfg.leading, { justify: false });
  return makeLayoutNode(sem, lines, cfg.before, cfg.after);
}

function layoutDisplayMath(sem) {
  const size = STYLE.fontSize * 1.05;
  const m = layoutMath(sem.ast, size);
  const shift = Math.max(0, (PAGE.textWidth - m.w) / 2);
  const runs = m.runs.map((r) =>
    r.rule
      ? { rule: true, x: shift + r.x, dy: r.dy, w: r.w, h: r.h }
      : { text: r.text, x: shift + r.x, dy: r.dy, size: r.size, style: { i: r.it ? 1 : 0, b: 0, tt: 0 } }
  );
  const line = {
    runs,
    w: m.w,
    ascent: m.asc + 2,
    descent: m.desc + 2,
    h: m.asc + m.desc + 5,
  };
  return makeLayoutNode(sem, [line], STYLE.mathPad, STYLE.mathPad);
}

function layoutList(sem, refsResolver) {
  const size = STYLE.fontSize;
  const indent = STYLE.listIndent;
  const width = PAGE.textWidth - indent;
  const allLines = [];
  let n = 0;
  for (const itemRuns of sem.items) {
    n++;
    const marker = sem.ordered ? `${n}.` : '•';
    const items = runsToItems(itemRuns, size, refsResolver);
    const lines = breakLines(items, width, width, STYLE.leading, { justify: true });
    lines.forEach((ln, idx) => {
      const runs = ln.runs.map((r) => ({ ...r, x: r.x + indent }));
      if (idx === 0) {
        runs.unshift({
          text: marker,
          x: indent - measure(marker, { i: 0, b: 0, tt: 0 }, size) - 6,
          dy: 0,
          size,
          style: { i: 0, b: 0, tt: 0 },
        });
      }
      allLines.push({ ...ln, runs, itemFirst: idx === 0 });
    });
  }
  return makeLayoutNode(sem, allLines, STYLE.parskip, STYLE.parskip);
}

function makeLayoutNode(sem, lines, before, after) {
  const node = {
    id: 'L-' + sem.blockId,
    blockId: sem.blockId,
    kind: sem.type,
    lines,
    spacingBefore: before,
    spacingAfter: after,
    height:
      before + after + lines.reduce((s, ln) => s + ln.h, 0),
    units: null,
  };
  const last = lines.length - 1;
  node.units = lines.map((ln, i) => ({
    blockId: sem.blockId,
    layoutId: node.id,
    li: i,
    ln,
    pre: i === 0 ? before : 0,
    post: i === last ? after : 0,
    h: ln.h,
    keepWithNext: sem.type === 'section', // headings never end a page
  }));
  return node;
}
