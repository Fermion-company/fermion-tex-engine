// Display List — the drawing commands for one page.
//
// The display list is the engine's primary output state (PDF is derived from
// it on demand). Every glyph run is positioned absolutely by the engine's
// own metrics, so any viewer that honors x/y positions reproduces the layout.

import { PAGE } from './layout.js';
import { faceOf } from './metrics.js';
import { fnv1a } from './hash.js';

/** Build the display list for a page. Returns { page, commands, hash }. */
export function buildDisplayList(page) {
  const commands = [];
  const ox = PAGE.marginX;
  const oy = PAGE.marginTop;

  for (const { u, y } of page.units) {
    for (const r of u.ln.runs) {
      if (r.rule) {
        commands.push({
          op: 'rule',
          x: round(ox + r.x),
          y: round(oy + y + r.dy - r.h),
          w: round(r.w),
          h: round(r.h),
          src: u.blockId,
        });
      } else if (r.text) {
        commands.push({
          op: 'glyphs',
          font: faceOf(r.style),
          size: r.size,
          x: round(ox + r.x),
          y: round(oy + y + (r.dy || 0)),
          text: r.text,
          src: u.blockId,
        });
      }
    }
  }

  // footer: centered page number
  const num = String(page.number);
  commands.push({
    op: 'glyphs',
    font: 'regular',
    size: 9,
    x: round(PAGE.width / 2 - num.length * 2.3),
    y: PAGE.height - 52,
    text: num,
    src: '_footer',
  });

  const dl = { page: page.number, commands };
  dl.hash = fnv1a(JSON.stringify(commands));
  return dl;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
