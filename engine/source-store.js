// Source Store — the mutable text buffer at the very top of the pipeline.
// Holds the current source of each file and applies range edits. Also maps
// byte offsets to line:column for reporting.

export class SourceStore {
  constructor() {
    this.files = new Map(); // name -> { text, lineStarts }
  }

  open(name, text) {
    this.files.set(name, { text, lineStarts: computeLineStarts(text) });
  }

  get(name) {
    return this.files.get(name)?.text ?? '';
  }

  /**
   * Replace [start, end) with `replacement`. Returns the length delta.
   */
  applyEdit(name, start, end, replacement) {
    const f = this.files.get(name);
    if (!f) throw new Error(`unknown file: ${name}`);
    const n = f.text.length;
    start = Math.max(0, Math.min(start, n));
    end = Math.max(start, Math.min(end, n));
    f.text = f.text.slice(0, start) + replacement + f.text.slice(end);
    f.lineStarts = computeLineStarts(f.text);
    return replacement.length - (end - start);
  }

  /** offset -> { line (1-based), column (1-based) } */
  position(name, offset) {
    const f = this.files.get(name);
    if (!f) return { line: 1, column: 1 };
    const ls = f.lineStarts;
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - ls[lo] + 1 };
  }
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}
