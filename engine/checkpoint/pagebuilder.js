// pagebuilder.js — the checkpoint engine's output routine.
//
// A faithful single-column reimplementation of LaTeX's page maker over the
// real galley stream: line units flow onto pages, footnote inserts reserve
// space at the bottom of the text (\skip\footins + rule, exactly like
// \@makecol), floats are dispatched per their placement spec:
//
//   h  inline at the anchor when it fits, else falls back to t
//   t  top area of the current page (only while its body is still empty)
//      or of a following page, bounded by \topfraction
//   b  bottom area of the current or a following page (\bottomfraction)
//   p  float pages
//
// Page order matches LaTeX defaults: [top floats] [text] [footnotes]
// [bottom floats]. Everything placed is identity-stable, so unchanged pages
// are adopted wholesale by the reconciler and their display lists survive.

export function buildPages(stream, geo) {
  const H = geo.textheight;
  const footSkip = geo.footinsskip ?? 9;
  const ruleGap = 6; // \footnoterule: 0.4pt rule inside ~6bp of vertical space
  const floatSep = geo.floatsep ?? 12;
  const textFloatSep = geo.textfloatsep ?? 20;
  const inTextSep = geo.intextsep ?? 12;
  const topFrac = geo.topfraction ?? 0.7;
  const botFrac = geo.bottomfraction ?? 0.3;

  const pages = [];
  let queue = []; // deferred floats, document order

  let cur = null;

  const newPage = () => {
    cur = {
      number: pages.length + 1,
      body: [], // {u, yRel} baseline relative to body start
      topFloats: [], // float objects
      botFloats: [],
      feet: [], // footnote unit lists (flattened)
      yBody: 0,
      topH: 0,
      botH: 0,
      footH: 0,
    };
  };

  const footExtra = () => (cur.footH > 0 ? footSkip + ruleGap : 0);
  const avail = () => H - cur.topH - cur.botH - cur.footH - footExtra();

  const tryTop = (f) => {
    if (cur.body.length > 0) return false;
    const add = f.h + (cur.topFloats.length ? floatSep : textFloatSep);
    if (cur.topH + add > topFrac * H) return false;
    if (cur.topH + add + cur.botH + cur.footH + footExtra() > H) return false;
    cur.topFloats.push(f);
    cur.topH += add;
    return true;
  };

  const tryBottom = (f) => {
    const add = f.h + (cur.botFloats.length ? floatSep : textFloatSep);
    if (cur.botH + add > botFrac * H) return false;
    if (cur.yBody + cur.topH + cur.botH + add + cur.footH + footExtra() > H) return false;
    cur.botFloats.push(f);
    cur.botH += add;
    return true;
  };

  const tryFloatPage = (f) => {
    if (cur.body.length || cur.topFloats.length || cur.botFloats.length) return false;
    cur.topFloats.push(f);
    cur.topH += f.h;
    closePage();
    return true;
  };

  const dispatchFloat = (f, allowInline) => {
    const spec = (f.placement || 'tbp').toLowerCase().replace('!', '');
    if (allowInline && spec.includes('h')) {
      const need = inTextSep + f.h + inTextSep;
      if (cur.yBody + need <= avail()) {
        // inline: becomes body content at the anchor
        cur.body.push({ inlineFloat: f, yRel: cur.yBody + inTextSep });
        cur.yBody += need;
        return;
      }
    }
    if (spec.includes('t') && tryTop(f)) return;
    if (spec.includes('b') && tryBottom(f)) return;
    queue.push(f);
  };

  const drainQueue = () => {
    const rest = [];
    for (const f of queue) {
      const spec = (f.placement || 'tbp').toLowerCase().replace('!', '');
      let placed = false;
      if (spec.includes('t')) placed = tryTop(f);
      if (!placed && spec.includes('b')) placed = tryBottom(f);
      if (!placed && (spec.includes('p') || f.h > 0.85 * H)) placed = tryFloatPage(f);
      if (!placed) rest.push(f);
    }
    queue = rest;
  };

  const closePage = () => {
    pages.push(cur);
    newPage();
    drainQueue();
  };

  newPage();
  drainQueue();

  let pendingKeep = []; // units held for keepWithNext (headings)

  const placeUnit = (u) => {
    const pre = cur.body.length === 0 ? 0 : u.pre;
    let footNeed = 0;
    if (u.inserts?.length) {
      for (const ins of u.inserts) footNeed += ins.h + 2;
    }
    if (cur.body.length > 0 && cur.yBody + pre + u.h + footNeed > avail()) {
      closePage();
      cur.body.push({ u, yRel: u.h - u.ln.descent });
      cur.yBody = u.h + u.post;
    } else {
      cur.body.push({ u, yRel: cur.yBody + pre + u.h - u.ln.descent });
      cur.yBody += pre + u.h + u.post;
    }
    if (u.inserts?.length) {
      for (const ins of u.inserts) {
        cur.feet.push(ins);
        cur.footH += ins.h + 2;
      }
    }
    for (const f of u.floats ?? []) dispatchFloat(f, true);
  };

  for (const u of stream) {
    if (u.keepWithNext) {
      pendingKeep.push(u);
      continue;
    }
    if (pendingKeep.length) {
      const groupH =
        pendingKeep.reduce((s, p) => s + (cur.body.length ? p.pre : 0) + p.h + p.post, 0) +
        u.pre +
        u.h;
      if (cur.body.length > 0 && cur.yBody + groupH > avail()) closePage();
      for (const p of pendingKeep) placeUnit(p);
      pendingKeep = [];
    }
    placeUnit(u);
  }
  for (const p of pendingKeep) placeUnit(p);
  if (cur.body.length || cur.topFloats.length || cur.botFloats.length || cur.feet.length) {
    closePage();
  }
  // remaining floats spill onto trailing pages
  let guard = 0;
  while (queue.length && guard++ < 50) {
    const before = queue.length;
    drainQueue();
    if (queue.length === before) {
      // nothing placeable even on a fresh page: force a float page
      const f = queue.shift();
      cur.topFloats.push(f);
      cur.topH += f.h;
    }
    if (cur.topFloats.length || cur.body.length) closePage();
  }
  if (cur.body.length || cur.topFloats.length) closePage();
  if (!pages.length) {
    pages.push(cur);
  }

  // ---- absolute layout pass: compute draw entries per page --------------
  for (const page of pages) {
    const draw = []; // {u, y} baseline in text-area coordinates
    const identity = [];
    let y = 0;
    for (const f of page.topFloats) {
      layoutFloat(f, y, draw, identity);
      y += f.h + textFloatSep;
    }
    const bodyTop = y;
    for (const entry of page.body) {
      if (entry.inlineFloat) {
        layoutFloat(entry.inlineFloat, bodyTop + entry.yRel, draw, identity);
      } else {
        draw.push({ u: entry.u, y: bodyTop + entry.yRel });
        identity.push(entry.u);
      }
    }
    y = bodyTop + page.yBody;
    if (page.feet.length) {
      y += footSkip;
      draw.push({ rule: { w: geo.textwidth * 0.4, h: 0.4 }, y });
      y += ruleGap;
      for (const ins of page.feet) {
        for (const fu of ins.units) {
          draw.push({ u: fu, y: y + fu.yRel });
          identity.push(fu);
        }
        y += ins.h + 2;
      }
    }
    if (page.botFloats.length) {
      y += textFloatSep;
      for (const f of page.botFloats) {
        layoutFloat(f, y, draw, identity);
        y += f.h + floatSep;
      }
    }
    page.draw = draw;
    page.identity = identity;
    page.startUnit = identity[0] ?? null;
    // legacy shape used elsewhere
    page.units = page.body.filter((e) => e.u).map((e) => ({ u: e.u, y: bodyTop + e.yRel }));
  }
  return pages;
}

function layoutFloat(f, yTop, draw, identity) {
  identity.push(f);
  for (const fu of f.units) {
    draw.push({ u: fu, y: yTop + fu.yRel, float: f });
  }
}

/** Adopt unchanged page objects (display lists survive by identity). */
export function reconcile(newPages, oldPages) {
  let reused = 0;
  const pages = newPages.map((np) => {
    const op = oldPages[np.number - 1];
    if (op && op.number === np.number && sameIdentity(op, np)) {
      reused++;
      return op;
    }
    return np;
  });
  return { pages, reused, rebuilt: pages.length - reused };
}

function sameIdentity(a, b) {
  const ia = a.identity ?? [];
  const ib = b.identity ?? [];
  if (ia.length !== ib.length) return false;
  for (let i = 0; i < ia.length; i++) if (ia[i] !== ib[i]) return false;
  const da = a.draw ?? [];
  const db = b.draw ?? [];
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) {
    if (da[i].u !== db[i].u || Math.abs(da[i].y - db[i].y) > 0.01) return false;
  }
  return true;
}
