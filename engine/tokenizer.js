// TeX tokenizer.
//
// Tokenizes a source slice under standard catcodes. The engine tokenizes
// per block, only for dirty blocks — this is the "re-tokenize the necessary
// range only" step of the pipeline. Blocks are small, so this is cheap.
//
// Token kinds:
//   {t:'cs',   name, start, end}  control sequence (word or symbol)
//   {t:'ch',   c, start}          ordinary character
//   {t:'{',    start} {t:'}', start}
//   {t:'$',    start}             math shift
//   {t:'#',    n, start}          macro parameter
//   {t:'~',    start}             tie (non-breaking space)
//   {t:'sp',   start}             run of whitespace (blocks contain no blank lines)

const LETTER = /[a-zA-Z@]/;

export function tokenize(src, base = 0) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      let j = i + 1;
      if (j < n && LETTER.test(src[j])) {
        while (j < n && LETTER.test(src[j])) j++;
        toks.push({ t: 'cs', name: src.slice(i + 1, j), start: base + i, end: base + j });
        // TeX skips whitespace after a control word.
        while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
        i = j;
      } else {
        const name = j < n ? src[j] : '';
        toks.push({ t: 'cs', name, start: base + i, end: base + j + 1 });
        i = j + 1;
      }
    } else if (c === '%') {
      // Comment: to end of line, consuming the newline.
      while (i < n && src[i] !== '\n') i++;
      if (i < n) i++;
    } else if (c === '{') {
      toks.push({ t: '{', start: base + i });
      i++;
    } else if (c === '}') {
      toks.push({ t: '}', start: base + i });
      i++;
    } else if (c === '$') {
      toks.push({ t: '$', start: base + i });
      i++;
    } else if (c === '#') {
      if (i + 1 < n && /[1-9]/.test(src[i + 1])) {
        toks.push({ t: '#', n: +src[i + 1], start: base + i });
        i += 2;
      } else {
        toks.push({ t: 'ch', c: '#', start: base + i });
        i++;
      }
    } else if (c === '~') {
      toks.push({ t: '~', start: base + i });
      i++;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      const start = i;
      while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
      toks.push({ t: 'sp', start: base + start });
    } else {
      toks.push({ t: 'ch', c, start: base + i });
      i++;
    }
  }
  return toks;
}

/** Reconstruct approximate source text from a token slice (for hashing / math). */
export function serializeTokens(toks) {
  let out = '';
  for (const tk of toks) {
    switch (tk.t) {
      case 'cs':
        out += '\\' + tk.name + (/[a-zA-Z@]$/.test(tk.name) ? ' ' : '');
        break;
      case 'ch': out += tk.c; break;
      case '{': out += '{'; break;
      case '}': out += '}'; break;
      case '$': out += '$'; break;
      case '#': out += '#' + tk.n; break;
      case '~': out += '~'; break;
      case 'sp': out += ' '; break;
    }
  }
  return out;
}

/**
 * Read a balanced {...} group starting at index i (toks[i].t must be '{').
 * Returns { inner: tokens inside, next: index after closing brace, closed }.
 * Unclosed groups are tolerated (auto-close at end) so the engine stays
 * alive while the user is mid-keystroke.
 */
export function readGroup(toks, i) {
  let depth = 1;
  const inner = [];
  let j = i + 1;
  while (j < toks.length) {
    const tk = toks[j];
    if (tk.t === '{') depth++;
    else if (tk.t === '}') {
      depth--;
      if (depth === 0) return { inner, next: j + 1, closed: true };
    }
    inner.push(tk);
    j++;
  }
  return { inner, next: j, closed: false };
}
