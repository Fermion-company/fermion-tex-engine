// Macro VM — macro definition scanning and token-level expansion.
//
// The preamble is scanned for \newcommand / \renewcommand / \providecommand /
// simple \def. Each definition carries a hash of its parameter count + body,
// which is the unit of macro dependency tracking: a block's expansion cache
// records exactly which macro definitions it consumed (name -> defHash), so a
// macro redefinition invalidates precisely the blocks that used it.

import { tokenize, serializeTokens, readGroup } from './tokenizer.js';
import { fnv1a } from './hash.js';

const MAX_DEPTH = 64;

/** Scan preamble text for macro definitions. Returns Map name -> def. */
export function scanMacros(preambleText) {
  const table = new Map();
  const toks = tokenize(preambleText, 0);
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === 'cs' && (tk.name === 'newcommand' || tk.name === 'renewcommand' || tk.name === 'providecommand')) {
      i++;
      // optional star
      if (toks[i]?.t === 'ch' && toks[i].c === '*') i++;
      // \name either as {\name} or bare \name
      let name = null;
      if (toks[i]?.t === '{') {
        const g = readGroup(toks, i);
        const inner = g.inner.filter((t) => t.t !== 'sp');
        if (inner.length === 1 && inner[0].t === 'cs') name = inner[0].name;
        i = g.next;
      } else if (toks[i]?.t === 'cs') {
        name = toks[i].name;
        i++;
      }
      if (!name) continue;
      // optional [n]
      let nparams = 0;
      if (toks[i]?.t === 'ch' && toks[i].c === '[') {
        let j = i + 1;
        let digits = '';
        while (j < toks.length && !(toks[j].t === 'ch' && toks[j].c === ']')) {
          if (toks[j].t === 'ch') digits += toks[j].c;
          j++;
        }
        nparams = parseInt(digits, 10) || 0;
        i = j + 1;
        // skip optional default value [..]
        if (toks[i]?.t === 'ch' && toks[i].c === '[') {
          while (i < toks.length && !(toks[i].t === 'ch' && toks[i].c === ']')) i++;
          i++;
        }
      }
      // body group
      if (toks[i]?.t === '{') {
        const g = readGroup(toks, i);
        i = g.next;
        define(table, name, nparams, g.inner);
      }
    } else if (tk.t === 'cs' && tk.name === 'def') {
      // simple \def\name{body} (no parameter text)
      i++;
      if (toks[i]?.t === 'cs') {
        const name = toks[i].name;
        i++;
        if (toks[i]?.t === '{') {
          const g = readGroup(toks, i);
          i = g.next;
          define(table, name, 0, g.inner);
        }
      }
    } else {
      i++;
    }
  }
  return table;
}

function define(table, name, nparams, bodyToks) {
  const bodySrc = serializeTokens(bodyToks);
  table.set(name, {
    name,
    nparams,
    body: bodyToks,
    hash: fnv1a(nparams + '|' + bodySrc),
    src: bodySrc,
  });
}

/** name -> defHash snapshot of an entire macro table. */
export function macroSnapshot(table) {
  const snap = {};
  for (const [k, v] of table) snap[k] = v.hash;
  return snap;
}

/** Set of macro names whose definition changed / appeared / vanished. */
export function changedMacros(oldTable, newTable) {
  const changed = new Set();
  for (const [k, v] of newTable) {
    const o = oldTable.get(k);
    if (!o || o.hash !== v.hash) changed.add(k);
  }
  for (const k of oldTable.keys()) {
    if (!newTable.has(k)) changed.add(k);
  }
  return changed;
}

/**
 * Expand user macros in a token stream.
 * Returns { toks, used } where `used` maps macro name -> defHash consumed.
 * Built-in commands (\section, \emph, ...) are left for the semantic layer.
 */
export function expandTokens(toks, table, used = new Map(), depth = 0, diagnostics = []) {
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === 'cs' && table.has(tk.name)) {
      const def = table.get(tk.name);
      used.set(tk.name, def.hash);
      if (depth >= MAX_DEPTH) {
        diagnostics.push(`macro recursion limit reached expanding \\${tk.name}`);
        out.push(tk);
        i++;
        continue;
      }
      i++;
      const args = [];
      for (let k = 0; k < def.nparams; k++) {
        while (toks[i]?.t === 'sp') i++;
        if (toks[i]?.t === '{') {
          const g = readGroup(toks, i);
          args.push(g.inner);
          i = g.next;
        } else if (i < toks.length) {
          args.push([toks[i]]);
          i++;
        } else {
          args.push([]);
        }
      }
      const substituted = [];
      for (const bt of def.body) {
        if (bt.t === '#') {
          const arg = args[bt.n - 1] || [];
          // Re-anchor argument tokens at the call site position.
          for (const at of arg) substituted.push({ ...at, start: tk.start });
        } else {
          substituted.push({ ...bt, start: tk.start });
        }
      }
      const inner = expandTokens(substituted, table, used, depth + 1, diagnostics);
      out.push(...inner.toks);
    } else {
      out.push(tk);
      i++;
    }
  }
  return { toks: out, used, diagnostics };
}
