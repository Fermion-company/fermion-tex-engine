// pagebuilder.js — TeX's page builder + LaTeX's output routine, transcribed.
//
// The input stream is the document's REAL main vertical list (harvested
// node-by-node from the resident lualatex, see daemon.lua): boxes, glue with
// full stretch/shrink specs, penalties (club/widow/section — TeX's own
// values), footnote inserts at their true stream positions, float anchors
// and eject markers. This module re-runs, in JavaScript, exactly the
// algorithms that consume that list in a vanilla run:
//
//   - the page builder's break-cost machinery (tex.web §1005–1008):
//     legal breakpoints, badness, insert accounting against \pagegoal,
//     best-break selection, \topskip, \maxdepth;
//   - LaTeX's float placement (ltoutput: \@addtocurcol, \@addtotoporbot,
//     \@addtobot, \@startcolumn, \@tryfcolumn) with the class's real
//     \topfraction/\bottomfraction/\textfraction/\floatpagefraction,
//     topnumber/bottomnumber/totalnumber and separation glues;
//   - \@makecol page assembly: \skip\footins + the class's measured
//     \footnoterule recipe + stacked inserts, \@combinefloats, and the
//     final vbox-to-\@colht glue setting (which is what makes
//     \raggedbottom/\flushbottom come out right: the .0001fil absorbs
//     the slack exactly like TeX's glue setting does).
//
// No dimension in this file is invented; everything comes from the stream
// or from parameters measured in the live TeX run.

const AWFUL = 0x3fffffff; // tex.web awful_bad
const INF_BAD = 10000;
const DEPLORABLE = 100000;
const EJECT = -10000;

// TeX's badness function (tex.web §108), computed in scaled points.
function badness(tBp, sBp) {
  const t = Math.round(tBp * 65781.76);
  const s = Math.round(sBp * 65781.76);
  if (t === 0) return 0;
  if (s <= 0) return INF_BAD;
  let r;
  if (t <= 7230584) r = Math.floor((t * 297) / s);
  else if (s >= 1663497) r = Math.floor(t / Math.floor(s / 297));
  else r = t;
  if (r > 1290) return INF_BAD;
  return Math.floor((r * r * r + 0x20000) / 0x40000);
}

const G0 = { w: 0, st: 0, sh: 0, sto: 0, sho: 0 };
function glueOf(g, fallbackW = 0) {
  if (g == null) return { ...G0, w: fallbackW };
  if (typeof g === 'number') return { ...G0, w: g };
  return { w: g.w ?? 0, st: g.st ?? 0, sh: g.sh ?? 0, sto: g.sto ?? 0, sho: g.sho ?? 0 };
}
function negGlue(g) {
  return { w: -g.w, st: -g.st, sh: -g.sh, sto: g.sto, sho: g.sho };
}

/** Parse a float placement spec exactly like \@xfloat parses #2. */
export function parsePlacement(spec) {
  let bits = 0;
  let bang = false;
  for (const ch of String(spec || '').toLowerCase()) {
    if (ch === 'h') bits |= 1;
    else if (ch === 't') bits |= 2;
    else if (ch === 'b') bits |= 4;
    else if (ch === 'p') bits |= 8;
    else if (ch === '!') bang = true;
  }
  if (bits === 0) bits = 2 | 4 | 8; // \@fpsadddefault (tbp)
  if (bits === 1) bits = 1 | 2; // \@resethfps: `h' alone becomes `ht'
  return { bits, bang };
}

export function buildPages(stream, geo) {
  return new PageBuilder(stream, geo).run();
}

class PageBuilder {
  constructor(stream, geo) {
    this.geo = geo;
    this.queue = stream.slice(); // working queue (we splice float material in)
    this.qi = 0;
    this.pages = [];
    this.deferlist = [];

    this.textheight = geo.textheight;
    this.maxdepth = geo.atmaxdepth ?? geo.maxdepth ?? 4;
    this.topskip = glueOf(geo.topskip, 10);
    this.footskip = glueOf(geo.footinsskip, 9);
    this.footFactor = (geo.footinsfactor ?? 1000) / 1000;
    this.floatsep = glueOf(geo.floatsep, 12);
    this.textfloatsep = glueOf(geo.textfloatsep, 20);
    this.intextsep = glueOf(geo.intextsep, 12);
    this.fptop = glueOf(geo.fptop, 0);
    this.fpsep = glueOf(geo.fpsep, 8);
    this.fpbot = glueOf(geo.fpbot, 0);
    this.parskip = glueOf({ w: geo.parskip ?? 0, st: 1, sto: 0 }); // stream carries real parskip; only used for \vskip-\parskip after vmode h-floats
    this.interlinepenalty = geo.interlinepenalty ?? 0;
    this.raggedbottom = (geo.raggedbottom ?? 1) === 1;
    this.footruleUnit = footruleUnitFor(geo);

    this.#startColumnState();
    this.#resetPage();
  }

  // ---- LaTeX column state (\@floatplacement / \@startcolumn) -------------

  #startColumnState() {
    const g = this.geo;
    this.colht = this.textheight; // \@colht
    this.colroom = this.colht; // \@colroom
    this.topnum = g.topnumber ?? 2;
    this.botnum = g.bottomnumber ?? 1;
    this.colnum = g.totalnumber ?? 3;
    this.toproom = (g.topfraction ?? 0.7) * this.colht;
    this.botroom = (g.bottomfraction ?? 0.3) * this.colht;
    this.fpmin = (g.floatpagefraction ?? 0.5) * this.colht;
    this.textfloatsheight = 0; // \@textfloatsheight
    this.toplist = [];
    this.botlist = [];
    this.midlist = [];
  }

  // ---- TeX page-builder state --------------------------------------------

  #resetPage() {
    this.contents = []; // placed entries: {e (stream entry), …}
    this.total = 0; // \pagetotal
    this.depth = 0; // \pagedepth
    this.stretch = [0, 0, 0, 0]; // by order
    this.shrink = 0;
    this.shrinkInf = false;
    this.hasBox = false; // topskip not yet inserted
    this.feet = []; // ins entries accepted on this page (in order)
    this.footSeen = false;
    this.best = null; // {index into contents, cost}
    this.lastPen = 0; // most recent penalty passed (for @nobreak emulation)
  }

  get goal() {
    // \pagegoal = \vsize (= \@colroom after float commits), reduced by
    // insert accounting (first footins: -\skip\footins; each: -height*f)
    let g = this.colroom;
    if (this.footSeen) {
      g -= this.footskip.w;
      for (const f of this.feet) g -= f.e.h * this.footFactor;
    }
    return g;
  }

  // pageht as \@specialoutput measures it before \@addtocurcol
  get pageht() {
    let h = this.total + this.depth;
    if (this.footSeen) {
      h += this.footskip.w;
      for (const f of this.feet) h += f.e.h * this.footFactor;
    }
    return h;
  }

  // ------------------------------------------------------------------ run

  run() {
    while (this.qi < this.queue.length) {
      const e = this.queue[this.qi++];
      switch (e.t) {
        case 'box':
          this.#contributeBox(e);
          break;
        case 'glue':
          this.#contributeGlue(e);
          break;
        case 'kern':
          this.#contributeKern(e);
          break;
        case 'pen':
          this.#contributePen(e);
          break;
        case 'ins':
          this.#contributeIns(e);
          break;
        case 'fm':
          this.#handleFloat(e);
          break;
        case 'eject':
          this.#handleEject(e);
          break;
        default:
          break;
      }
    }
    // end of document: \enddocument runs \clearpage, whose \newpage puts
    // \vfil before the eject — that fil is what pins bottom floats to the
    // page bottom on the final page. Reproduce it literally.
    this.finishing = true;
    if (this.contents.some((c) => c.e.t === 'box' || c.e.t === 'ins') ||
        this.toplist.length || this.botlist.length) {
      if (this.hasBox) this.#contributeGlue({ t: 'glue', a: 0, st: 1, sto: 1, sh: 0, sho: 0 });
      this.#firePage(this.contents.length, null);
    }
    while (this.deferlist.length) {
      const made = this.#tryFloatColumn(true);
      if (!made) break;
    }
    if (!this.pages.length) this.#emitEmptyPage();
    return this.pages;
  }

  // ------------------------------------------------- contributions (§997+)

  #pageEmpty() {
    return !this.hasBox && this.feet.length === 0;
  }

  #contributeBox(e) {
    if (!this.hasBox) {
      // \topskip: glue above the first box, natural = max(topskip - h, 0)
      const eff = Math.max(this.topskip.w - e.u.h, 0);
      this.contents.push({
        e: { t: 'glue', a: eff, st: this.topskip.st, sto: this.topskip.sto, sh: this.topskip.sh, sho: this.topskip.sho, sub: 10 },
        topskip: true,
      });
      this.total += eff;
      this.stretch[this.topskip.sto] += this.topskip.st;
      if (this.topskip.sho === 0) this.shrink += this.topskip.sh;
      else if (this.topskip.sh) this.shrinkInf = true;
      this.hasBox = true;
    }
    this.total += this.depth + e.u.h;
    this.depth = e.u.d;
    if (this.depth > this.maxdepth) {
      this.total += this.depth - this.maxdepth;
      this.depth = this.maxdepth;
    }
    this.contents.push({ e });
    this.#checkOverfull();
  }

  #contributeGlue(e) {
    if (!this.hasBox) return; // discardables above the first box are dropped
    const prev = this.contents[this.contents.length - 1];
    const prevNondiscardable =
      prev && (prev.e.t === 'box' || prev.e.t === 'ins' || prev.e.t === 'rule');
    if (prevNondiscardable && this.#evalBreak(this.contents.length, 0, e)) {
      // the page fired; the glue re-enters via the queue in document order
      return;
    }
    this.contents.push({ e });
    this.total += e.a ?? 0;
    this.stretch[e.sto ?? 0] += e.st ?? 0;
    if ((e.sho ?? 0) === 0) this.shrink += e.sh ?? 0;
    else if (e.sh) this.shrinkInf = true;
  }

  #contributeKern(e) {
    if (!this.hasBox) return;
    // a kern is a breakpoint when immediately followed by glue
    const next = this.queue[this.qi];
    if (next && next.t === 'glue' && this.#evalBreak(this.contents.length, 0, e)) {
      return;
    }
    this.contents.push({ e });
    this.total += e.a ?? 0;
  }

  #contributePen(e) {
    this.lastPen = e.v;
    if (!this.hasBox) return;
    if (e.v < INF_BAD) this.#evalBreak(this.contents.length, e.v, null);
    // penalties occupy no space and need not be stored; if the page fired
    // at this penalty it has been consumed by the break
  }

  #contributeIns(e) {
    // inserts are non-discardable; accepted even before the first box
    if (!this.footSeen) this.footSeen = true;
    const entry = { e };
    this.feet.push(entry);
    this.contents.push(entry);
    this.#checkOverfull();
  }

  #handleEject(e) {
    if (e.v <= -10001) {
      // \clearpage's second eject (\vbox{}\penalty-\@Mi): \@doclearpage
      // DISCARDS the ejected material (it is only the empty marker vbox)
      // when \footins is void, then flushes deferred floats as float pages.
      if (this.feet.length) {
        this.#firePage(this.contents.length, null);
      } else {
        this.contents = [];
        this.#resetPage();
      }
      while (this.deferlist.length) {
        if (!this.#tryFloatColumn(true)) break;
      }
      return;
    }
    // \newpage (-10000): forced break at this point
    if (this.hasBox || this.feet.length || this.toplist.length || this.botlist.length) {
      const fired = this.#evalBreak(this.contents.length, EJECT, null);
      if (!fired) this.#firePage(this.contents.length, null);
    }
  }

  // --------------------------------------------- break costs (tex.web §1005)

  /** @returns true when the page fired (pending item re-enters via queue). */
  #evalBreak(index, pi, pending) {
    if (pi >= INF_BAD) return false;
    let b;
    if (this.total < this.goal) {
      b = this.stretch[1] || this.stretch[2] || this.stretch[3]
        ? 0
        : badness(this.goal - this.total, this.stretch[0]);
    } else if (this.total - this.goal > this.shrink && !this.shrinkInf) {
      b = AWFUL;
    } else {
      b = badness(this.total - this.goal, this.shrinkInf ? 1e9 : this.shrink);
    }
    let c;
    if (b < AWFUL) {
      if (pi <= EJECT) c = pi;
      else if (b < INF_BAD) c = b + pi;
      else c = DEPLORABLE;
    } else c = b;
    if (this.best === null || c <= this.best.cost) {
      this.best = { index, cost: c, pen: pi };
    }
    if (c === AWFUL || pi <= EJECT) {
      this.#firePage(this.best.index, this.best.pen, pending);
      return true;
    }
    return false;
  }

  #checkOverfull() {
    // a box/ins landing may push the page beyond goal+shrink with the next
    // breakpoint far away; TeX fires at the next legal breakpoint, which
    // #evalBreak handles — nothing to do eagerly.
  }

  // ------------------------------------------------------- float dispatch

  #floatHt(f) {
    return f.h + f.d;
  }

  /** \@addtocurcol — the float was just declared at the current position. */
  #handleFloat(e) {
    const f = e.f;
    let inserted = false;
    let inline = false;
    const fpstype = f.place.bang ? f.place.bits : f.place.bits | 16;
    if (fpstype !== 8 && fpstype !== 24) {
      // \@flsettextmin (+ accumulated h-float heights)
      let textmin = f.place.bang ? 0 : (this.geo.textfraction ?? 0.2) * this.colht;
      textmin += this.textfloatsheight;
      let reqcolroom = Math.max(textmin, this.pageht) + this.#floatHt(f);
      if (this.colroom > reqcolroom) {
        // \@flsetnum \@colnum
        if (this.colnum === 0 && f.place.bang) this.colnum = 1;
        if (this.colnum > 0) {
          const sameTypeDeferred = this.deferlist.some((d) => d.type === f.type);
          if (!sameTypeDeferred) {
            const sameTypeInBot = this.botlist.some((d) => d.type === f.type);
            if (sameTypeInBot) {
              inserted = this.#addToBot(f, reqcolroom);
            } else {
              if (f.place.bits & 1) {
                const req2 = reqcolroom + this.intextsep.w;
                if (this.colroom > req2) {
                  // inline `h` placement: the float becomes text material
                  this.colnum--;
                  this.textfloatsheight += this.#floatHt(f) + 2 * this.intextsep.w;
                  this.midlist.push(f);
                  const inject = [
                    { t: 'pen', v: this.lastPen >= INF_BAD ? INF_BAD : this.interlinepenalty },
                    { t: 'glue', a: this.intextsep.w, st: this.intextsep.st, sto: this.intextsep.sto, sh: this.intextsep.sh, sho: this.intextsep.sho },
                    { t: 'box', u: floatAsUnit(f) },
                    { t: 'pen', v: this.interlinepenalty },
                    { t: 'glue', a: this.intextsep.w, st: this.intextsep.st, sto: this.intextsep.sto, sh: this.intextsep.sh, sho: this.intextsep.sho },
                  ];
                  if (e.vmode) {
                    // \ifnum\outputpenalty<-\@Mii \vskip-\parskip\fi
                    const ng = negGlue(this.parskip);
                    inject.push({ t: 'glue', a: ng.w, st: ng.st, sto: ng.sto, sh: ng.sh, sho: ng.sho });
                  }
                  this.queue.splice(this.qi, 0, ...inject);
                  inserted = true;
                  inline = true;
                }
              }
              if (!inserted) inserted = this.#addToTopOrBot(f, reqcolroom);
            }
          }
        }
      }
    }
    if (process.env.TDOM_DEBUG_FLOATS) {
      console.error(`float ${f.id} [bits=${f.place.bits}] at pageht=${this.pageht.toFixed(1)} colroom=${this.colroom.toFixed(1)} -> ${inserted ? (inline ? 'inline' : 'top/bot') : 'defer'}`);
    }
    if (!inserted) this.deferlist.push(f);
    if (!inline) {
      // \@specialoutput tail: \addpenalty\interlinepenalty at the anchor
      // (\nobreak instead while @nobreak is in force, i.e. after a heading)
      this.queue.splice(this.qi, 0, {
        t: 'pen',
        v: this.lastPen >= INF_BAD ? INF_BAD : this.interlinepenalty,
      });
    }
  }

  /** \@addtotoporbot — reqcolroom arrives from the caller, like \@reqcolroom. */
  #addToTopOrBot(f, reqcolroom) {
    if (f.place.bits & 2) {
      if (this.topnum === 0 && f.place.bang) this.topnum = 1;
      if (process.env.TDOM_DEBUG_FLOATS) {
        console.error(`  toporbot ${f.id}: topnum=${this.topnum} sep=${this.toplist.length ? this.floatsep.w : this.textfloatsep.w} colroom=${this.colroom} req+sep=${reqcolroom + (this.toplist.length ? this.floatsep.w : this.textfloatsep.w)} toproom=${this.toproom} ht=${this.#floatHt(f)}`);
      }
      if (this.topnum > 0) {
        const sep = this.toplist.length ? this.floatsep.w : this.textfloatsep.w;
        // \@flcheckspace \@toproom \@toplist
        if (
          this.colroom > reqcolroom + sep &&
          (this.toproom > this.#floatHt(f) || f.place.bang)
        ) {
          const collision =
            this.midlist.some((d) => d.type === f.type) ||
            this.botlist.some((d) => d.type === f.type);
          if (!collision) {
            // \@flupdates
            this.topnum--;
            this.colnum--;
            this.toproom -= this.#floatHt(f) + sep;
            this.colroom -= this.#floatHt(f) + sep;
            this.toplist.push(f);
            return true;
          }
        }
      }
    }
    return this.#addToBot(f, reqcolroom);
  }

  /** \@addtobot */
  #addToBot(f, reqcolroom) {
    if (!(f.place.bits & 4)) return false;
    if (this.botnum === 0 && f.place.bang) this.botnum = 1;
    if (this.botnum <= 0) return false;
    const sep = this.botlist.length ? this.floatsep.w : this.textfloatsep.w;
    if (!(this.colroom > reqcolroom + sep)) return false;
    if (!(this.botroom > this.#floatHt(f) || f.place.bang)) return false;
    // \@flupdates (+ \global\maxdepth\z@ in \@addtobot — depth detail only)
    this.botnum--;
    this.colnum--;
    this.botroom -= this.#floatHt(f) + sep;
    this.colroom -= this.#floatHt(f) + sep;
    this.botlist.push(f);
    return true;
  }

  // ------------------------------------------------------ page completion

  /**
   * fire_up: contents[0..breakIndex) become the page; the breakpoint item is
   * consumed/discarded per TeX rules; later items (and their inserts) are
   * re-queued for the next page.
   */
  #firePage(breakIndex, breakPen, pending = null) {
    const placed = this.contents.slice(0, breakIndex);
    const rest = this.contents.slice(breakIndex);
    // stored entries after the break re-enter the stream, followed by the
    // item that was in flight when the page fired (document order!); the
    // discard rules of the fresh page then drop what TeX would drop.
    const requeue = [];
    for (const c of rest) {
      if (c.topskip) continue;
      requeue.push(c.e);
    }
    if (pending) requeue.push(pending);
    const feetOnPage = this.feet.filter((fe) => placed.includes(fe));
    this.#emitPage(placed, feetOnPage);

    // \@opcol: fresh column state, then \@startcolumn (float pages +
    // deferred float retry), then text resumes
    this.#startColumnState();
    this.#resetPage();
    while (this.#tryFloatColumn(false)) {
      /* successive float pages */
    }
    // \@startcolumn: retry the deferred floats for the new column (skipped
    // while finishing — the end-of-document path flushes via float pages)
    if (this.deferlist.length && !this.finishing) {
      const defer = this.deferlist;
      this.deferlist = [];
      for (const f of defer) this.#addToNextCol(f);
    }
    // re-feed the leftover items through the normal contribution path
    if (requeue.length) this.queue.splice(this.qi, 0, ...requeue);
  }

  /** \@addtonextcol */
  #addToNextCol(f) {
    let inserted = false;
    const fpstype = f.place.bang ? f.place.bits : f.place.bits | 16;
    if (fpstype !== 8 && fpstype !== 24) {
      const textmin = f.place.bang ? 0 : (this.geo.textfraction ?? 0.2) * this.colht;
      const reqcolroom = this.#floatHt(f) + textmin;
      if (this.colroom > reqcolroom) {
        if (this.colnum === 0 && f.place.bang) this.colnum = 1;
        if (this.colnum > 0) {
          const sameTypeDeferred = this.deferlist.some((d) => d.type === f.type);
          if (!sameTypeDeferred) inserted = this.#addToTopOrBot(f, reqcolroom);
        }
      }
    }
    if (process.env.TDOM_DEBUG_FLOATS) {
      console.error(`nextcol ${f.id} colroom=${this.colroom.toFixed(1)} ht=${this.#floatHt(f).toFixed(1)} -> ${inserted ? 'placed' : 'defer'}`);
    }
    if (!inserted) this.deferlist.push(f);
  }

  /** \@tryfcolumn — attempt to build a float page from the defer list. */
  #tryFloatColumn(force) {
    if (!this.deferlist.length) return false;
    const colht = this.colht;
    const fpmin = force ? -Infinity : this.fpmin;
    const failed = [];
    let acc = null;
    let i = 0;
    while (i < this.deferlist.length && !acc) {
      const f = this.deferlist[i];
      const pOk = force || (f.place.bits & 8);
      if (!pOk || failed.some((d) => d.type === f.type) || this.#floatHt(f) > colht) {
        failed.push(f);
        i++;
        continue;
      }
      const group = [f];
      const fail2 = [];
      let total = this.#floatHt(f);
      for (let j = i + 1; j < this.deferlist.length; j++) {
        const g = this.deferlist[j];
        const gOk = force || (g.place.bits & 8);
        if (
          !gOk ||
          failed.some((d) => d.type === g.type) ||
          fail2.some((d) => d.type === g.type) ||
          total + this.#floatHt(g) + this.fpsep.w > colht
        ) {
          fail2.push(g);
          continue;
        }
        group.push(g);
        total += this.#floatHt(g) + this.fpsep.w;
      }
      if (total > fpmin) {
        acc = group;
        this.deferlist = [...failed, ...fail2];
      } else {
        failed.push(f);
        i++;
      }
    }
    if (!acc) return false;
    this.#emitFloatPage(acc);
    this.#startColumnState();
    return true;
  }

  // --------------------------------------------------------- page assembly

  /**
   * \@makecol + \@combinefloats + the final \vbox to \@colht glue setting.
   * Produces absolute draw entries (baseline y in text-area coordinates).
   */
  #emitPage(placed, feet) {
    const g = [];   // vertical elements: {kind:'glue',spec}|{kind:'box',...}
    const toplist = this.toplist;
    const botlist = this.botlist;
    this.pageFeet = feet;
    this.pageTop = toplist.slice();
    this.pageBot = botlist.slice();

    // -- top floats (\@cflt): [box + floatsep]… -floatsep + textfloatsep
    for (let i = 0; i < toplist.length; i++) {
      g.push({ kind: 'float', f: toplist[i] });
      g.push({ kind: 'glue', spec: i === toplist.length - 1 ? this.textfloatsep : this.floatsep });
    }
    // -- text body
    for (const c of placed) {
      const e = c.e;
      if (e.t === 'box') {
        if (e.u.isFloat) g.push({ kind: 'float', f: e.u.isFloat }); // inline `h`
        else g.push({ kind: 'unit', u: e.u });
      } else if (e.t === 'glue') {
        g.push({ kind: 'glue', spec: glueOf({ w: e.a, st: e.st, sh: e.sh, sto: e.sto, sho: e.sho }) });
      } else if (e.t === 'kern') {
        g.push({ kind: 'glue', spec: glueOf(e.a) });
      }
      // ins entries occupy no space in the text body
    }
    // -- footnotes (\@makecol): \vskip\skip\footins, \footnoterule, inserts
    if (feet.length) {
      g.push({ kind: 'glue', spec: this.footskip });
      if (this.footruleUnit) {
        for (const it of this.footruleUnit) {
          if (it.kind === 'glue') g.push({ kind: 'glue', spec: it.spec });
          else g.push({ kind: 'unit', u: it.u });
        }
      }
      for (const fe of feet) {
        // insert contents are spliced verbatim (no interline glue between
        // insertions — footnote struts carry the spacing, like TeX)
        g.push({ kind: 'mini', units: fe.e.units, height: fe.e.hc, d: fe.e.d ?? 0 });
      }
    }
    // -- bottom floats (\@cflb): textfloatsep + [box + floatsep]… -floatsep
    if (botlist.length) {
      g.push({ kind: 'glue', spec: this.textfloatsep });
      for (let i = 0; i < botlist.length; i++) {
        g.push({ kind: 'float', f: botlist[i] });
        if (i < botlist.length - 1) g.push({ kind: 'glue', spec: this.floatsep });
      }
    }
    // -- \@makecol's final packaging: \dimen@=\dp\@outputbox …
    //    \vskip-\dimen@ cancels the trailing depth before \@textbottom
    let dpLast = 0;
    for (let i = g.length - 1; i >= 0; i--) {
      const el = g[i];
      if (el.kind === 'unit') { dpLast = el.u.d; break; }
      if (el.kind === 'float') { dpLast = el.f.d; break; }
      if (el.kind === 'mini') {
        dpLast = el.d ?? 0; // real \dp of the insert material (ins node)
        break;
      }
    }
    if (dpLast) g.push({ kind: 'glue', spec: { w: -dpLast, st: 0, sh: 0, sto: 0, sho: 0 } });
    // -- \@textbottom (raggedbottom: \vskip 0pt plus .0001fil)
    if (this.raggedbottom) {
      g.push({ kind: 'glue', spec: { w: 0, st: 0.0001, sto: 1, sh: 0, sho: 0 } });
    }
    this.#layoutAndPush(g, this.colht);
  }

  /** \@vtryfc float page: \@fptop [\@fpsep box]… \@fpbot in a vbox to colht. */
  #emitFloatPage(group) {
    this.pageTop = group.slice();
    const g = [];
    g.push({ kind: 'glue', spec: this.fptop });
    g.push({ kind: 'glue', spec: negGlue(this.fpsep) });
    for (const f of group) {
      g.push({ kind: 'glue', spec: this.fpsep });
      g.push({ kind: 'float', f });
    }
    g.push({ kind: 'glue', spec: this.fpbot });
    this.#layoutAndPush(g, this.colht);
  }

  #emitEmptyPage() {
    this.#layoutAndPush([], this.colht);
  }

  /** Distribute glue exactly like vpack-to-goal, then place baselines. */
  #layoutAndPush(elems, goalHeight) {
    if (process.env.TDOM_DEBUG_LAYOUT) {
      console.error(`--- page ${this.pages.length + 1} elems:`);
      for (const el of elems) {
        if (el.kind === 'glue') console.error(`  glue ${el.spec.w} st=${el.spec.st}@${el.spec.sto}`);
        else if (el.kind === 'unit') console.error(`  unit h=${el.u.h} d=${el.u.d} "${(el.u.ln?.runs ?? []).filter((r) => r.t).map((r) => r.t).join('').slice(0, 30)}"`);
        else console.error(`  float ${el.f.id} h=${el.f.h}`);
      }
    }
    // natural size + stretch/shrink pools
    let natural = 0;
    const st = [0, 0, 0, 0];
    const sh = [0, 0, 0, 0];
    for (const el of elems) {
      if (el.kind === 'glue') {
        natural += el.spec.w;
        st[el.spec.sto ?? 0] += el.spec.st ?? 0;
        sh[el.spec.sho ?? 0] += el.spec.sh ?? 0;
      } else if (el.kind === 'unit') {
        natural += el.u.h + el.u.d;
      } else if (el.kind === 'float') {
        natural += el.f.h + el.f.d;
      } else if (el.kind === 'mini') {
        natural += el.height;
      }
    }
    const excess = goalHeight - natural;
    if (process.env.TDOM_DEBUG_GLUESET) {
      console.error(`glueset page ${this.pages.length + 1}: natural=${natural.toFixed(4)} goal=${goalHeight.toFixed(4)} excess=${excess.toFixed(4)} st=[${st.map((v) => v.toFixed(3))}] sh=[${sh.map((v) => v.toFixed(3))}]`);
    }
    let order = 0;
    let ratio = 0;
    let shrinking = false;
    if (excess > 0) {
      order = st[3] ? 3 : st[2] ? 2 : st[1] ? 1 : 0;
      ratio = st[order] > 0 ? excess / st[order] : 0;
    } else if (excess < 0) {
      shrinking = true;
      order = sh[3] ? 3 : sh[2] ? 2 : sh[1] ? 1 : 0;
      ratio = sh[order] > 0 ? Math.min(-excess / sh[order], order === 0 ? 1 : Infinity) : 0;
    }
    const setGlue = (spec) => {
      let v = spec.w;
      if (!shrinking && ratio && (spec.sto ?? 0) === order) v += (spec.st ?? 0) * ratio;
      if (shrinking && ratio && (spec.sho ?? 0) === order) v -= (spec.sh ?? 0) * ratio;
      return v;
    };

    const draw = [];
    const identity = [];
    let y = 0;
    for (const el of elems) {
      if (el.kind === 'glue') {
        y += setGlue(el.spec);
      } else if (el.kind === 'unit') {
        y += el.u.h;
        draw.push({ u: el.u, y });
        identity.push(el.u);
        y += el.u.d;
      } else if (el.kind === 'float') {
        identity.push(el.f);
        for (const fu of el.f.units) {
          draw.push({ u: fu, y: y + fu.yRel, float: el.f });
        }
        y += el.f.h + el.f.d;
      } else if (el.kind === 'mini') {
        for (const fu of el.units) {
          draw.push({ u: fu, y: y + fu.yRel });
          identity.push(fu);
        }
        y += el.height;
      }
    }
    const page = {
      number: this.pages.length + 1,
      draw,
      identity,
      startUnit: identity[0] ?? null,
      feet: this.pageFeet ?? [],
      topFloats: this.pageTop ?? [],
      botFloats: this.pageBot ?? [],
    };
    this.pageFeet = null;
    this.pageTop = null;
    this.pageBot = null;
    this.pages.push(page);
  }
}

/** A committed inline float participates in the text stream as one big box. */
function floatAsUnit(f) {
  f.__unit ??= {
    blockId: f.blockId,
    li: -1,
    h: f.h,
    d: f.d,
    isFloat: f,
    ln: { descent: f.d, boxH: f.h, runs: [], gfxChunk: null },
  };
  return f.__unit;
}

/**
 * The class's \footnoterule recipe (measured items from the driver) as
 * layout elements: kerns become glue, rules become drawable units.
 * Memoized per geometry object so page identities survive rebuilds.
 */
const footruleCache = new WeakMap();
function footruleUnitFor(geo) {
  if (footruleCache.has(geo)) return footruleCache.get(geo);
  const out = computeFootrule(geo);
  footruleCache.set(geo, out);
  return out;
}

function computeFootrule(geo) {
  const items = geo.footruleitems;
  if (!items) return null;
  const out = [];
  for (const it of items) {
    if (it.k === 'kern' || it.k === 'glue') {
      out.push({ kind: 'glue', spec: glueOf(it.a ?? 0) });
    } else if (it.k === 'box') {
      out.push({
        kind: 'unit',
        u: {
          blockId: '_footrule',
          li: -1,
          h: it.h ?? 0,
          d: it.d ?? 0,
          ln: { descent: it.d ?? 0, boxH: it.h ?? 0, runs: it.runs ?? [], gfxChunk: null },
        },
      });
    }
  }
  return out;
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
