// Semantic DOM builder.
//
// Consumes a block's *expanded* token stream (Macro VM output) and produces a
// semantic node: section, paragraph, list, or display math. Inline content
// becomes runs: styled text, inline math, refs. Labels and refs are recorded
// on the node — the dependency graph is derived from them.
//
// The builder is deliberately fault-tolerant: unknown commands become visible
// typewriter text plus a diagnostic, unclosed groups auto-close. The engine
// must survive every intermediate keystroke.

import { readGroup, serializeTokens } from './tokenizer.js';
import { parseMath } from './math-layout.js';

const STYLE_CMDS = {
  emph: (s) => ({ ...s, i: s.i ? 0 : 1 }),
  textit: (s) => ({ ...s, i: 1 }),
  textbf: (s) => ({ ...s, b: 1 }),
  texttt: (s) => ({ ...s, tt: 1 }),
  textrm: (s) => ({ ...s, i: 0, tt: 0 }),
  textsf: (s) => s,
  textsc: (s) => s,
};

// Commands swallowed silently (with their argument groups).
const SWALLOW = {
  documentclass: 1, usepackage: 1, newcommand: 2, renewcommand: 2,
  providecommand: 2, def: 2, title: 1, author: 1, date: 1, maketitle: 0,
  pagestyle: 1, setlength: 2, vspace: 1, hspace: 1, noindent: 0,
  centering: 0, tableofcontents: 0, bibliographystyle: 1, bibliography: 1,
};

export function buildSemanticNode(block, toks, diagnostics) {
  const ctx = {
    labels: [],
    refs: [],
    diagnostics,
  };
  let i = 0;
  while (i < toks.length && toks[i].t === 'sp') i++;
  const first = toks[i];

  if (first?.t === 'cs' && (first.name === 'section' || first.name === 'subsection' || first.name === 'subsubsection')) {
    const level = first.name === 'section' ? 1 : first.name === 'subsection' ? 2 : 3;
    i++;
    // optional [short title]
    if (toks[i]?.t === 'ch' && toks[i].c === '[') {
      while (i < toks.length && !(toks[i].t === 'ch' && toks[i].c === ']')) i++;
      i++;
    }
    let titleRuns = [];
    if (toks[i]?.t === '{') {
      const g = readGroup(toks, i);
      titleRuns = parseInline(g.inner, ctx);
      i = g.next;
    }
    // trailing tokens (e.g. \label after the heading) — collect labels only
    parseInline(toks.slice(i), ctx);
    return {
      id: 'sec-' + block.id,
      blockId: block.id,
      type: 'section',
      level,
      titleRuns,
      labels: ctx.labels,
      refs: ctx.refs,
      number: null,
    };
  }

  if (first?.t === 'cs' && first.name === '[') {
    // \[ ... \]
    let j = i + 1;
    const inner = [];
    while (j < toks.length && !(toks[j].t === 'cs' && toks[j].name === ']')) {
      inner.push(toks[j]);
      j++;
    }
    const rest = toks.slice(j + 1);
    parseInline(rest, ctx);
    const src = serializeTokens(inner).trim();
    return displayMathNode(block, src, ctx);
  }

  if (first?.t === 'cs' && first.name === 'begin') {
    const g = toks[i + 1]?.t === '{' ? readGroup(toks, i + 1) : null;
    const env = g ? serializeTokens(g.inner).trim() : '';
    const bodyStart = g ? g.next : i + 1;
    const bodyToks = stripEnvEnd(toks.slice(bodyStart), env);

    if (env === 'itemize' || env === 'enumerate') {
      return listNode(block, env === 'enumerate', bodyToks, ctx, diagnostics);
    }
    if (env === 'equation' || env === 'equation*' || env === 'displaymath') {
      const labelless = [];
      for (let k = 0; k < bodyToks.length; k++) {
        const tk = bodyToks[k];
        if (tk.t === 'cs' && tk.name === 'label' && bodyToks[k + 1]?.t === '{') {
          const lg = readGroup(bodyToks, k + 1);
          ctx.labels.push(serializeTokens(lg.inner).trim());
          k = lg.next - 1;
          continue;
        }
        labelless.push(tk);
      }
      const src = serializeTokens(labelless).trim();
      return displayMathNode(block, src, ctx);
    }
    if (env === 'center' || env === 'quote' || env === 'flushleft') {
      const runs = parseInline(bodyToks, ctx);
      return paragraphNode(block, runs, ctx, env === 'center');
    }
    diagnostics.push(`unsupported environment "${env}" rendered as paragraph`);
    const runs = parseInline(bodyToks, ctx);
    return paragraphNode(block, runs, ctx, false);
  }

  // Plain paragraph.
  const runs = parseInline(toks.slice(i), ctx);
  return paragraphNode(block, runs, ctx, false);
}

function paragraphNode(block, runs, ctx, centered) {
  return {
    id: 'para-' + block.id,
    blockId: block.id,
    type: 'paragraph',
    runs,
    centered: !!centered,
    labels: ctx.labels,
    refs: ctx.refs,
  };
}

function displayMathNode(block, src, ctx) {
  return {
    id: 'math-' + block.id,
    blockId: block.id,
    type: 'displaymath',
    src,
    ast: parseMath(src),
    labels: ctx.labels,
    refs: ctx.refs,
  };
}

function listNode(block, ordered, toks, ctx, diagnostics) {
  const items = [];
  let cur = null;
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === 'cs' && tk.name === 'item') {
      if (cur) items.push(cur);
      cur = [];
      i++;
      continue;
    }
    if (cur) cur.push(tk);
    i++;
  }
  if (cur) items.push(cur);
  return {
    id: 'list-' + block.id,
    blockId: block.id,
    type: 'list',
    ordered,
    items: items.map((itemToks) => parseInline(itemToks, ctx)),
    labels: ctx.labels,
    refs: ctx.refs,
  };
}

function stripEnvEnd(toks, env) {
  // Remove trailing \end{env} (and anything after it in this block).
  for (let i = toks.length - 1; i >= 0; i--) {
    if (toks[i].t === 'cs' && toks[i].name === 'end') {
      return toks.slice(0, i);
    }
  }
  return toks;
}

/**
 * Parse inline content into runs.
 * Run kinds:
 *   { kind:'text', text, style:{i,b,tt} }
 *   { kind:'math', src, ast }
 *   { kind:'ref', key, style }
 */
export function parseInline(toks, ctx, style = { i: 0, b: 0, tt: 0 }) {
  const runs = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      runs.push({ kind: 'text', text: buf, style: { ...style } });
      buf = '';
    }
  };

  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    switch (tk.t) {
      case 'ch':
        buf += tk.c;
        i++;
        break;
      case 'sp':
        buf += ' ';
        i++;
        break;
      case '~':
        buf += ' ';
        i++;
        break;
      case '{': {
        const g = readGroup(toks, i);
        flush();
        runs.push(...parseInline(g.inner, ctx, style));
        i = g.next;
        break;
      }
      case '}':
        i++; // stray close brace: tolerate
        break;
      case '$': {
        // inline math until next $
        let j = i + 1;
        const inner = [];
        while (j < toks.length && toks[j].t !== '$') {
          inner.push(toks[j]);
          j++;
        }
        flush();
        const src = serializeTokens(inner).trim();
        runs.push({ kind: 'math', src, ast: parseMath(src) });
        i = j + 1;
        break;
      }
      case '#':
        buf += '#' + tk.n;
        i++;
        break;
      case 'cs': {
        const name = tk.name;
        if (STYLE_CMDS[name]) {
          i++;
          if (toks[i]?.t === '{') {
            const g = readGroup(toks, i);
            flush();
            runs.push(...parseInline(g.inner, ctx, STYLE_CMDS[name](style)));
            i = g.next;
          }
          break;
        }
        if (name === 'label' || name === 'ref' || name === 'eqref' || name === 'pageref' || name === 'cite') {
          i++;
          let key = '';
          if (toks[i]?.t === '{') {
            const g = readGroup(toks, i);
            key = serializeTokens(g.inner).trim();
            i = g.next;
          }
          if (name === 'label') {
            ctx.labels.push(key);
          } else if (name === 'cite') {
            flush();
            runs.push({ kind: 'text', text: `[${key}]`, style: { ...style } });
          } else {
            flush();
            ctx.refs.push(key);
            runs.push({ kind: 'ref', key, style: { ...style } });
          }
          break;
        }
        if (name === '\\') {
          buf += ' ';
          i++;
          // optional [len]
          if (toks[i]?.t === 'ch' && toks[i].c === '[') {
            while (i < toks.length && !(toks[i].t === 'ch' && toks[i].c === ']')) i++;
            i++;
          }
          break;
        }
        if (name === ' ' || name === '' ) { buf += ' '; i++; break; }
        if (['%', '&', '$', '#', '_', '{', '}'].includes(name)) {
          buf += name;
          i++;
          break;
        }
        if (name === 'ldots' || name === 'dots') { buf += '…'; i++; break; }
        if (name === 'LaTeX') { buf += 'LaTeX'; i++; break; }
        if (name === 'TeX') { buf += 'TeX'; i++; break; }
        if (SWALLOW[name] !== undefined) {
          i++;
          // optional [..]
          if (toks[i]?.t === 'ch' && toks[i].c === '[') {
            while (i < toks.length && !(toks[i].t === 'ch' && toks[i].c === ']')) i++;
            i++;
          }
          for (let a = 0; a < SWALLOW[name]; a++) {
            while (toks[i]?.t === 'sp') i++;
            if (toks[i]?.t === '{') i = readGroup(toks, i).next;
            else if (toks[i]?.t === 'cs') i++;
          }
          break;
        }
        if (name === 'begin' || name === 'end') {
          // stray env markers inside inline content: swallow the name group
          i++;
          if (toks[i]?.t === '{') i = readGroup(toks, i).next;
          break;
        }
        // Unknown command: keep the document honest — show it, flag it.
        ctx.diagnostics?.push(`unknown command \\${name}`);
        flush();
        runs.push({ kind: 'text', text: '\\' + name, style: { ...style, tt: 1 } });
        i++;
        break;
      }
      default:
        i++;
    }
  }
  flush();
  return mergeRuns(runs);
}

function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (
      prev && prev.kind === 'text' && r.kind === 'text' &&
      prev.style.i === r.style.i && prev.style.b === r.style.b && prev.style.tt === r.style.tt
    ) {
      prev.text += r.text;
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Stable serialization of a semantic node's *content* — the part of the node
 * that layout depends on. Used in layout cache keys.
 */
export function semSerial(node) {
  switch (node.type) {
    case 'section':
      return `sec${node.level}|${node.number}|${runsSerial(node.titleRuns)}`;
    case 'paragraph':
      return `para|${node.centered ? 'c' : ''}|${runsSerial(node.runs)}`;
    case 'displaymath':
      return `dmath|${node.src}`;
    case 'list':
      return `list|${node.ordered ? 'o' : 'u'}|${node.items.map(runsSerial).join('')}`;
    default:
      return node.type;
  }
}

function runsSerial(runs) {
  return runs
    .map((r) => {
      if (r.kind === 'text') return `t${r.style.i}${r.style.b}${r.style.tt}:${r.text}`;
      if (r.kind === 'math') return `m:${r.src}`;
      if (r.kind === 'ref') return `r:${r.key}`;
      return '';
    })
    .join(' ');
}
