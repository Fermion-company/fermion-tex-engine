// Math parser + layout.
//
// Parses a math source string (contents of $...$ or \[...\]) into a small
// atom list and lays it out into positioned draw runs, with class-based
// spacing (ord/bin/rel/punct), superscripts, subscripts and \frac.
// Deliberately a subset — but a real one: widths come from font metrics and
// the result participates in line breaking as a rigid box.

import { measure } from './metrics.js';

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SYMBOLS = {
  cdot: { text: '·', cls: 'bin' },
  times: { text: '×', cls: 'bin' },
  pm: { text: '±', cls: 'bin' },
  mp: { text: '∓', cls: 'bin' },
  le: { text: '≤', cls: 'rel' },
  leq: { text: '≤', cls: 'rel' },
  ge: { text: '≥', cls: 'rel' },
  geq: { text: '≥', cls: 'rel' },
  ne: { text: '≠', cls: 'rel' },
  neq: { text: '≠', cls: 'rel' },
  approx: { text: '≈', cls: 'rel' },
  equiv: { text: '≡', cls: 'rel' },
  to: { text: '→', cls: 'rel' },
  rightarrow: { text: '→', cls: 'rel' },
  mapsto: { text: '↦', cls: 'rel' },
  in: { text: '∈', cls: 'rel' },
  subset: { text: '⊂', cls: 'rel' },
  infty: { text: '∞', cls: 'ord' },
  partial: { text: '∂', cls: 'ord' },
  nabla: { text: '∇', cls: 'ord' },
  sum: { text: 'Σ', cls: 'op' },
  prod: { text: 'Π', cls: 'op' },
  int: { text: '∫', cls: 'op' },
  sqrt: { text: '√', cls: 'ord' },
  ldots: { text: '…', cls: 'ord' },
  dots: { text: '…', cls: 'ord' },
  quad: { kern: 10 },
  qquad: { kern: 20 },
  ',': { kern: 1.7 },
  ';': { kern: 2.8 },
  '!': { kern: -1.7 },
};

// ---------------------------------------------------------------- parsing

export function parseMath(src) {
  const nodes = [];
  let i = 0;
  const n = src.length;

  const attachScript = (kind) => {
    let prev = nodes[nodes.length - 1];
    if (!prev || prev.k === 'kern') {
      prev = { k: 'atom', cls: 'ord', text: '', it: false };
      nodes.push(prev);
    }
    const { list, next } = parseScriptArg(src, i + 1);
    i = next;
    prev[kind] = list;
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === '^') { attachScript('sup'); continue; }
    if (c === '_') { attachScript('sub'); continue; }
    if (c === '{') {
      const { inner, next } = readBraced(src, i);
      nodes.push({ k: 'grp', list: parseMath(inner) });
      i = next;
      continue;
    }
    if (c === '}') { i++; continue; } // stray
    if (c === '\\') {
      let j = i + 1;
      if (j < n && /[a-zA-Z]/.test(src[j])) {
        while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        const name = src.slice(i + 1, j);
        i = j;
        if (name === 'frac') {
          const a = parseArg(src, i);
          const b = parseArg(src, a.next);
          i = b.next;
          nodes.push({ k: 'frac', num: parseMath(a.text), den: parseMath(b.text) });
        } else if (GREEK[name]) {
          nodes.push({ k: 'atom', cls: 'ord', text: GREEK[name], it: true });
        } else if (SYMBOLS[name]) {
          const s = SYMBOLS[name];
          if (s.kern !== undefined) nodes.push({ k: 'kern', w: s.kern });
          else nodes.push({ k: 'atom', cls: s.cls, text: s.text, it: false });
        } else if (['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det'].includes(name)) {
          nodes.push({ k: 'atom', cls: 'op', text: name, it: false });
        } else {
          // Unknown control sequence: render its name upright.
          nodes.push({ k: 'atom', cls: 'ord', text: name, it: false });
        }
        continue;
      }
      // control symbol
      const sym = j < n ? src[j] : '';
      i = j + 1;
      if (SYMBOLS[sym]?.kern !== undefined) nodes.push({ k: 'kern', w: SYMBOLS[sym].kern });
      else if (sym) nodes.push({ k: 'atom', cls: 'ord', text: sym, it: false });
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      nodes.push({ k: 'atom', cls: 'ord', text: c, it: true });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      nodes.push({ k: 'atom', cls: 'ord', text: src.slice(i, j), it: false });
      i = j;
      continue;
    }
    if (c === '+' || c === '-' || c === '−') {
      nodes.push({ k: 'atom', cls: 'bin', text: c === '-' ? '−' : c, it: false });
      i++;
      continue;
    }
    if (c === '=' || c === '<' || c === '>') {
      nodes.push({ k: 'atom', cls: 'rel', text: c, it: false });
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '|') {
      nodes.push({ k: 'atom', cls: 'open', text: c, it: false });
      i++;
      continue;
    }
    if (c === ')' || c === ']') {
      nodes.push({ k: 'atom', cls: 'close', text: c, it: false });
      i++;
      continue;
    }
    if (c === ',' || c === ';') {
      nodes.push({ k: 'atom', cls: 'punct', text: c, it: false });
      i++;
      continue;
    }
    nodes.push({ k: 'atom', cls: 'ord', text: c, it: false });
    i++;
  }
  return nodes;
}

function readBraced(src, i) {
  let depth = 1;
  let j = i + 1;
  const start = j;
  while (j < src.length) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return { inner: src.slice(start, j), next: j + 1 };
    }
    j++;
  }
  return { inner: src.slice(start), next: j };
}

function parseArg(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '{') {
    const { inner, next } = readBraced(src, i);
    return { text: inner, next };
  }
  if (src[i] === '\\') {
    let j = i + 1;
    while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
    return { text: src.slice(i, j), next: j };
  }
  return { text: src[i] ?? '', next: i + 1 };
}

function parseScriptArg(src, i) {
  const { text, next } = parseArg(src, i);
  return { list: parseMath(text), next };
}

// ---------------------------------------------------------------- layout

const SPACING = { bin: 2.2, rel: 2.8, op: 1.7 };

/**
 * Lay out a math atom list.
 * Returns { runs, w, asc, desc } — runs carry {text,x,dy,size,it} or
 * {rule:true,x,dy,w,h}. dy is a baseline shift (negative = raised).
 */
export function layoutMath(list, size) {
  const runs = [];
  let x = 0;
  let asc = size * 0.7;
  let desc = size * 0.22;
  let prevCls = null;

  const scale = size / 10;

  for (const node of list) {
    if (node.k === 'kern') {
      x += node.w * scale;
      continue;
    }
    if (node.k === 'grp') {
      const sub = layoutMath(node.list, size);
      for (const r of sub.runs) runs.push({ ...r, x: r.x + x });
      x += sub.w;
      asc = Math.max(asc, sub.asc);
      desc = Math.max(desc, sub.desc);
      prevCls = 'ord';
      continue;
    }
    if (node.k === 'frac') {
      if (prevCls !== null && SPACING[prevCls] !== undefined) x += SPACING[prevCls] * scale;
      const fs = Math.max(size * 0.75, 6);
      const num = layoutMath(node.num, fs);
      const den = layoutMath(node.den, fs);
      const w = Math.max(num.w, den.w) + 3 * scale;
      const axis = -2.6 * scale;
      const ruleY = axis;
      const numShift = ruleY - 2.2 * scale - num.desc;
      const denShift = ruleY + 2.2 * scale + den.asc;
      for (const r of num.runs) runs.push({ ...r, x: r.x + x + (w - num.w) / 2, dy: (r.dy || 0) + numShift });
      for (const r of den.runs) runs.push({ ...r, x: r.x + x + (w - den.w) / 2, dy: (r.dy || 0) + denShift });
      runs.push({ rule: true, x, dy: ruleY, w, h: 0.45 * scale });
      x += w;
      asc = Math.max(asc, -numShift + num.asc);
      desc = Math.max(desc, denShift + den.desc);
      prevCls = 'ord';
      continue;
    }
    // atom
    const cls = node.cls;
    const gap = SPACING[cls] ?? (SPACING[prevCls] ?? 0);
    if (prevCls !== null && (SPACING[cls] !== undefined || SPACING[prevCls] !== undefined)) {
      x += Math.max(SPACING[cls] ?? 0, SPACING[prevCls] ?? 0) * scale;
    }
    if (node.text) {
      runs.push({ text: node.text, x, dy: 0, size, it: !!node.it });
      x += measure(node.text, { i: node.it }, size);
    }
    // scripts
    let scriptW = 0;
    if (node.sup) {
      const s = layoutMath(node.sup, Math.max(size * 0.7, 5));
      const shift = -0.38 * size;
      for (const r of s.runs) runs.push({ ...r, x: r.x + x, dy: (r.dy || 0) + shift });
      scriptW = Math.max(scriptW, s.w);
      asc = Math.max(asc, -shift + s.asc);
    }
    if (node.sub) {
      const s = layoutMath(node.sub, Math.max(size * 0.7, 5));
      const shift = 0.17 * size;
      for (const r of s.runs) runs.push({ ...r, x: r.x + x, dy: (r.dy || 0) + shift });
      scriptW = Math.max(scriptW, s.w);
      desc = Math.max(desc, shift + s.desc);
    }
    x += scriptW;
    if (cls === 'punct') x += 1.7 * scale;
    prevCls = cls;
  }
  return { runs, w: x, asc, desc };
}
