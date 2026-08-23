// AEON — HUD overlay. Pure DOM/CSS; it never touches Three.js (it only *reads* numbers off the
// camera object it is handed, to draw the minimap view box).
//
// Layout: top resource strip, bottom-left selection panel, right-edge dispatch queue, bottom
// right end-turn + world map, full-screen tech tree on T. Every anchor is derived from one
// safe-area inset (--safe) and one gutter (--gut) so the panel edges cannot drift apart.
//
// Data: everything comes from `opts.game.state` when the gameplay module is loaded — including
// its rules tables, so the tech tree is the game's real 32-tech graph and not a mock-up. Any
// field the game does not publish falls back to a demo value derived from the real map, so the
// HUD is always a complete frame instead of a half-empty debug overlay.
//
// Nothing here is downloaded: the two typefaces are generated below, the panel material is
// CSS gradients plus an SVG-turbulence film, and every icon is an inline path drawn on one grid.
import { neighbors, hexDistance } from '../world/hex.js';
import './hud.css';


// mini path language: M/L/Q/Z, absolute, em = 1000, baseline 0, cap 700, x-height 490.
// glyph = [advance, weight, path, weight, path, ...]
const GLYPHS = {
  ' ': [300],
  A: [680, .82, 'M40 0L340 700L640 0', .55, 'M132 196L548 196'],
  B: [648, 1, 'M120 0L120 700', .78, 'M120 700L392 700Q560 700 560 552Q560 396 392 396L120 396', .84, 'M120 396L424 396Q604 396 604 200Q604 0 424 0L120 0'],
  C: [664, .85, 'M596 176Q510 -14 348 -14Q104 -14 104 350Q104 714 348 714Q510 714 596 524'],
  D: [688, 1, 'M120 0L120 700', .85, 'M120 700L364 700Q624 700 624 350Q624 0 364 0L120 0'],
  E: [600, 1, 'M120 0L120 700', .58, 'M120 700L564 700', .52, 'M120 376L484 376', .6, 'M120 0L576 0'],
  F: [572, 1, 'M120 0L120 700', .58, 'M120 700L556 700', .52, 'M120 376L472 376'],
  G: [716, .85, 'M596 524Q510 714 348 714Q104 714 104 350Q104 -14 348 -14Q518 -14 596 132L596 316', .58, 'M418 316L600 316'],
  H: [716, 1, 'M120 0L120 700', 1, 'M596 0L596 700', .55, 'M120 368L596 368'],
  I: [304, 1, 'M152 0L152 700'],
  J: [480, .9, 'M336 700L336 168Q336 -20 176 -20Q72 -20 42 96'],
  K: [668, 1, 'M120 0L120 700', .82, 'M604 700L184 336', .86, 'M292 428L628 0'],
  L: [564, 1, 'M120 0L120 700', .6, 'M120 0L544 0'],
  M: [848, .95, 'M112 0L112 700L424 148L736 700L736 0'],
  N: [732, .95, 'M120 0L120 700L612 0L612 700'],
  O: [748, .88, 'M374 714Q112 714 112 350Q112 -14 374 -14Q636 -14 636 350Q636 714 374 714Z'],
  P: [628, 1, 'M120 0L120 700', .82, 'M120 700L388 700Q596 700 596 542Q596 380 388 380L120 380'],
  Q: [748, .88, 'M374 714Q112 714 112 350Q112 -14 374 -14Q636 -14 636 350Q636 714 374 714Z', .78, 'M424 148L676 -108'],
  R: [648, 1, 'M120 0L120 700', .82, 'M120 700L388 700Q596 700 596 542Q596 380 388 380L120 380', .86, 'M336 380L620 0'],
  S: [604, .85, 'M544 556Q474 714 322 714Q140 714 140 566Q140 428 332 388Q532 344 532 190Q532 -14 320 -14Q158 -14 88 142'],
  T: [624, 1, 'M312 0L312 700', .58, 'M48 700L576 700'],
  U: [716, .92, 'M120 700L120 200Q120 -14 364 -14Q608 -14 608 200L608 700'],
  V: [680, .85, 'M40 700L340 0L640 700'],
  W: [968, .8, 'M40 700L232 0L484 552L736 0L928 700'],
  X: [664, .85, 'M60 700L604 0', .85, 'M604 700L60 0'],
  Y: [644, .85, 'M48 700L322 344L596 700', 1, 'M322 344L322 0'],
  Z: [628, .58, 'M76 700L556 700', .82, 'M556 700L88 0', .6, 'M88 0L568 0'],
  a: [624, .82, 'M170 384Q238 506 356 506Q506 506 506 352L506 96Q506 -10 612 16', .84, 'M506 244Q432 264 322 274Q150 292 150 138Q150 -14 322 -14Q442 -14 506 62'],
  b: [628, 1, 'M150 0L150 730', .84, 'M150 378Q222 506 342 506Q542 506 542 246Q542 -14 342 -14Q222 -14 150 108'],
  c: [576, .84, 'M512 380Q452 506 332 506Q142 506 142 246Q142 -14 332 -14Q452 -14 512 112'],
  d: [628, 1, 'M478 0L478 730', .84, 'M478 378Q406 506 286 506Q86 506 86 246Q86 -14 286 -14Q406 -14 478 108'],
  e: [592, .55, 'M142 252L524 252', .84, 'M524 252Q524 506 332 506Q142 506 142 246Q142 -14 332 -14Q464 -14 524 100'],
  f: [396, 1, 'M334 0L334 596Q334 738 502 712', .55, 'M156 488L494 488'],
  g: [628, .84, 'M542 490L542 -76Q542 -228 348 -228Q222 -228 162 -146', .84, 'M542 378Q470 506 350 506Q150 506 150 246Q150 -14 350 -14Q470 -14 542 108'],
  h: [628, 1, 'M150 0L150 730', .88, 'M150 348Q222 506 352 506Q532 506 532 328L532 0'],
  i: [300, 1, 'M150 0L150 490', 1.15, 'M104 632L196 632'],
  j: [340, .9, 'M276 490L276 -66Q276 -218 108 -192', 1.15, 'M230 632L322 632'],
  k: [588, 1, 'M150 0L150 730', .82, 'M524 490L202 218', .85, 'M300 300L546 0'],
  l: [300, 1, 'M150 0L150 730'],
  m: [900, .88, 'M150 0L150 490', .88, 'M150 348Q212 506 332 506Q464 506 464 328L464 0', .88, 'M464 348Q526 506 646 506Q778 506 778 328L778 0'],
  n: [628, .88, 'M150 0L150 490', .88, 'M150 348Q222 506 352 506Q532 506 532 328L532 0'],
  o: [648, .85, 'M344 506Q146 506 146 246Q146 -14 344 -14Q542 -14 542 246Q542 506 344 506Z'],
  p: [628, 1, 'M150 -200L150 490', .84, 'M150 378Q222 506 342 506Q542 506 542 246Q542 -14 342 -14Q222 -14 150 108'],
  q: [628, 1, 'M478 -200L478 490', .84, 'M478 378Q406 506 286 506Q86 506 86 246Q86 -14 286 -14Q406 -14 478 108'],
  r: [446, .88, 'M150 0L150 490', .78, 'M150 336Q234 506 404 506Q470 506 512 480'],
  s: [524, .84, 'M472 398Q414 506 302 506Q140 506 140 400Q140 300 302 274Q472 248 472 138Q472 -14 302 -14Q172 -14 122 88'],
  t: [472, .95, 'M296 490L296 128Q296 -14 458 12', .55, 'M126 398L466 398'],
  u: [628, .88, 'M150 490L150 142Q150 -14 330 -14Q462 -14 522 128', .88, 'M522 490L522 0'],
  v: [612, .82, 'M118 490L336 0L554 490'],
  w: [860, .78, 'M108 490L268 0L446 376L624 0L784 490'],
  x: [588, .82, 'M128 490L516 0', .82, 'M516 490L128 0'],
  y: [604, .82, 'M116 490L338 0', .82, 'M556 490L280 -200'],
  z: [572, .55, 'M128 490L498 490', .8, 'M498 490L138 0', .58, 'M138 0L518 0'],
  0: [648, .85, 'M324 714Q104 714 104 350Q104 -14 324 -14Q544 -14 544 350Q544 714 324 714Z'],
  1: [472, 1, 'M272 0L272 700', .68, 'M112 566L272 700', .58, 'M104 0L444 0'],
  2: [628, .85, 'M100 552Q142 714 322 714Q514 714 514 552Q514 396 300 248Q118 118 88 0', .6, 'M88 0L544 0'],
  3: [628, .85, 'M108 584Q170 714 332 714Q514 714 514 576Q514 436 322 416Q534 400 534 226Q534 -14 322 -14Q140 -14 88 126'],
  4: [648, .82, 'M424 0L424 700L68 186', .58, 'M68 186L596 186'],
  5: [628, .58, 'M148 700L524 700', .85, 'M148 700L128 396Q210 438 322 438Q534 438 534 212Q534 -14 312 -14Q140 -14 88 118'],
  6: [628, .85, 'M504 606Q444 714 322 714Q118 714 108 376Q98 -14 322 -14Q524 -14 524 188Q524 378 332 378Q140 378 110 226'],
  7: [608, .58, 'M76 700L548 700', .82, 'M548 700L262 0'],
  8: [640, .82, 'M320 372Q142 372 142 546Q142 714 320 714Q498 714 498 546Q498 372 320 372Z', .86, 'M320 372Q112 372 112 176Q112 -14 320 -14Q528 -14 528 176Q528 372 320 372Z'],
  9: [628, .85, 'M124 92Q184 -14 306 -14Q510 -14 520 324Q530 714 306 714Q104 714 104 512Q104 322 296 322Q488 322 518 474'],
  '.': [312, 1.1, 'M110 42L202 42'],
  ',': [312, .9, 'M180 40L128 -156'],
  ':': [312, 1.05, 'M112 42L200 42', 1.05, 'M112 396L200 396'],
  ';': [312, 1.05, 'M112 396L200 396', .9, 'M180 40L128 -156'],
  '-': [488, .55, 'M84 320L404 320'],
  '–': [700, .55, 'M70 320L630 320'],
  '—': [900, .55, 'M60 320L840 320'],
  '/': [560, .68, 'M56 -70L504 764'],
  '·': [312, 1.1, 'M110 336L202 336'],
  '!': [312, 1, 'M156 210L156 700', 1.1, 'M110 42L202 42'],
  '?': [568, .84, 'M84 550Q116 714 268 714Q436 714 436 566Q436 424 268 350L268 214', 1.1, 'M222 42L314 42'],
  "'": [258, .9, 'M130 700L130 512'],
  '"': [420, .9, 'M128 700L128 512', .9, 'M292 700L292 512'],
  '’': [258, .9, 'M130 700L130 512'],
  '+': [620, .55, 'M84 350L536 350', .55, 'M310 124L310 576'],
  '×': [560, .6, 'M120 470L440 150', .6, 'M440 470L120 150'],
  '%': [820, .62, 'M182 686Q72 686 72 566Q72 446 182 446Q292 446 292 566Q292 686 182 686Z', .62, 'M638 254Q528 254 528 134Q528 14 638 14Q748 14 748 134Q748 254 638 254Z', .58, 'M668 700L152 0'],
  '(': [388, .68, 'M312 760Q96 356 312 -60'],
  ')': [388, .68, 'M76 760Q292 356 76 -60'],
  '&': [740, .82, 'M690 44Q560 -14 452 78Q300 208 214 320Q140 416 236 490Q330 562 396 480Q460 400 336 316Q160 198 148 92Q140 -14 268 -14Q432 -14 540 176Q600 282 618 372', .55, 'M470 372L700 372'],
  '★': [700, .8, 'M350 700L440 430L720 430L494 262L580 -8L350 158L120 -8L206 262L-20 430L260 430Z'],
};

// ------------------------------------------------------------------ skeleton -> outline
const flat = d => {
  const pts = []; let closed = false;
  for (const seg of d.match(/[MLQZ][^MLQZ]*/g)) {
    const n = seg.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (seg[0] === 'M') pts.push([n[0], n[1]]);
    else if (seg[0] === 'L') for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    else if (seg[0] === 'Q') for (let i = 0; i < n.length; i += 4) {
      const p = pts[pts.length - 1];
      for (let k = 1; k <= 8; k++) { const u = k / 8, v = 1 - u;
        pts.push([v * v * p[0] + 2 * v * u * n[i] + u * u * n[i + 2], v * v * p[1] + 2 * v * u * n[i + 1] + u * u * n[i + 3]]); }
    } else closed = true;
  }
  if (closed && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1) pts.pop();
  return { pts, closed };
};
const area = c => { let a = 0; for (let i = 0; i < c.length; i++) { const p = c[i], q = c[(i + 1) % c.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const orient = (c, neg) => (area(c) < 0) === neg ? c : c.slice().reverse();

// Offset a centre-line by a (possibly varying) width, mitre-joined and mitre-clamped.
function offset(pts, closed, wAt) {
  const n = pts.length, m = closed ? n : n - 1, sg = [];
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    sg.push([-dy / l, dx / l]);
  }
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], w = wAt(n < 2 ? 0 : i / (n - 1)) / 2;
    const n1 = closed ? sg[(i - 1 + m) % m] : sg[Math.max(0, i - 1)], n2 = closed ? sg[i % m] : sg[Math.min(m - 1, i)];
    let bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = Math.hypot(bx, by);
    if (bl < 1e-6) { bx = n2[0]; by = n2[1]; bl = 1; }
    bx /= bl; by /= bl;
    const s = w / Math.max(.34, bx * n2[0] + by * n2[1]);
    L.push([p[0] + bx * s, p[1] + by * s]); R.push([p[0] - bx * s, p[1] - by * s]);
  }
  return closed ? [L, R.reverse()] : [L.concat(R.reverse())];
}

// One typeface instance. `cond` squeezes the skeleton horizontally (real condensation: the
// stems keep their weight), `flare` swells the terminals, `serif` hangs a slab off every free
// stroke end perpendicular to its tangent.
function buildOutlines({ stem, cond, flare, serif }) {
  const out = {};
  for (const ch in GLYPHS) {
    const g = GLYPHS[ch], contours = [];
    for (let i = 1; i < g.length; i += 2) {
      const W = stem * g[i], { pts, closed } = flat(g[i + 1]);
      for (const p of pts) p[0] *= cond;
      if (pts.length < 2) continue;
      const wAt = flare && !closed ? t => W * (1 + flare * Math.pow(Math.abs(2 * t - 1), 2.4)) : () => W;
      const cc = offset(pts, closed, wAt);
      if (closed) { const o = Math.abs(area(cc[0])) >= Math.abs(area(cc[1])) ? 0 : 1; contours.push([cc[o], false], [cc[1 - o], true]); }
      else contours.push([cc[0], false]);
      let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (serif && !closed && len > W * 3) for (const [a, b] of [[pts[0], pts[1]], [pts.at(-1), pts.at(-2)]]) {
        const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1, ex = -dy / l * W * 1.18, ey = dx / l * W * 1.18;
        for (const c of offset([[a[0] - ex, a[1] - ey], [a[0] + ex, a[1] + ey]], false, () => W * .5)) contours.push([c, false]);
      }
    }
    // nonzero winding: every solid contour clockwise (negative area), counters the other way.
    const cs = contours.map(([c, hole]) => orient(c, !hole)).filter(c => c.length > 2);
    // Fit the sidebearings to the drawn outline rather than the skeleton, so spacing stays even
    // no matter how far a stroke's weight pushes past its centre line.
    const sb = stem * (serif ? .58 : .52);
    let x0 = 1e9, x1 = -1e9;
    for (const c of cs) for (const p of c) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; }
    if (!cs.length) { out[ch] = { adv: Math.round(g[0] * cond), contours: [] }; continue; }
    for (const c of cs) for (const p of c) p[0] += sb - x0;
    out[ch] = { adv: Math.round(x1 - x0 + sb * 2), contours: cs };
  }
  return out;
}

// ------------------------------------------------------------------------ TrueType writer
class W {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 65536 : v); }
  u32(v) { return this.u16((v >>> 16) & 65535).u16(v & 65535); }
  bytes(b) { for (const x of b) this.a.push(x); return this; }
  str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
  utf16(s) { for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); return this; }
  pad() { while (this.a.length & 3) this.a.push(0); return this; }
  get out() { return new Uint8Array(this.a); }
}
const cksum = b => { let s = 0; for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) >>> 0; return s >>> 0; };

function ttf(faces, name) {
  const codes = Object.keys(faces).map(c => c.codePointAt(0)).sort((a, b) => a - b);
  const glyphs = [{ adv: 600, contours: [] }, ...codes.map(c => faces[String.fromCodePoint(c)])];
  let xMin = 32767, yMin = 32767, xMax = -32768, yMax = -32768, maxPts = 0, maxCon = 0, advMax = 0;

  const gw = new W(), loca = [0];
  for (const g of glyphs) {
    if (!g.contours.length) { loca.push(gw.a.length); advMax = Math.max(advMax, g.adv); continue; }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, np = 0;
    const pts = [];
    for (const c of g.contours) { for (const p of c) { const x = Math.round(p[0]), y = Math.round(p[1]); pts.push([x, y]);
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } np += c.length; }
    gw.i16(g.contours.length).i16(x0).i16(y0).i16(x1).i16(y1);
    let e = -1; for (const c of g.contours) { e += c.length; gw.u16(e); }
    gw.u16(0);
    for (let i = 0; i < np; i++) gw.u8(1);
    let px = 0; for (const p of pts) { gw.i16(p[0] - px); px = p[0]; }
    let py = 0; for (const p of pts) { gw.i16(p[1] - py); py = p[1]; }
    gw.pad(); loca.push(gw.a.length);
    xMin = Math.min(xMin, x0); yMin = Math.min(yMin, y0); xMax = Math.max(xMax, x1); yMax = Math.max(yMax, y1);
    maxPts = Math.max(maxPts, np); maxCon = Math.max(maxCon, g.contours.length); advMax = Math.max(advMax, g.adv);
  }
  const glyf = gw.out;
  const lw = new W(); for (const o of loca) lw.u32(o); const locaT = lw.out;
  const hw = new W(); for (const g of glyphs) hw.u16(g.adv).i16(0); const hmtx = hw.out;

  // cmap format 4, one segment per contiguous run of code points
  const runs = []; for (let i = 0; i < codes.length; i++) {
    if (i && codes[i] === codes[i - 1] + 1) runs.at(-1)[1] = codes[i]; else runs.push([codes[i], codes[i], i + 1]);
  }
  runs.push([0xffff, 0xffff, 0]);
  const sc = runs.length, sr = 2 * (1 << Math.floor(Math.log2(sc))), es = Math.floor(Math.log2(sc));
  const sub = new W().u16(4).u16(16 + sc * 8).u16(0).u16(sc * 2).u16(sr).u16(es).u16(sc * 2 - sr);
  for (const r of runs) sub.u16(r[1]);
  sub.u16(0);
  for (const r of runs) sub.u16(r[0]);
  for (const r of runs) sub.i16(r[2] ? (r[2] - r[0]) % 65536 : 1);
  for (const r of runs) sub.u16(0);
  const cmap = new W().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.out).out;

  const head = new W().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(11).u16(1000)
    .u32(0).u32(0).u32(0).u32(0).i16(xMin).i16(yMin).i16(xMax).i16(yMax).u16(0).u16(7).i16(2).i16(1).i16(0).out;
  const hhea = new W().u32(0x10000).i16(820).i16(-220).i16(0).u16(advMax).i16(xMin).i16(0).i16(xMax)
    .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(glyphs.length).out;
  const maxp = new W().u32(0x10000).u16(glyphs.length).u16(maxPts).u16(maxCon).u16(0).u16(0).u16(2)
    .u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).out;
  const os2 = new W().u16(4).i16(600).u16(400).u16(cond < 1 ? 4 : 5).u16(0)
    .i16(650).i16(650).i16(0).i16(0).i16(650).i16(650).i16(0).i16(480).i16(50).i16(260)
    .i16(0).bytes([2, 0, 5, 0, 0, 0, 0, 0, 0, 0]).u32(1).u32(0).u32(0).u32(0).str('AEON')
    .u16(0x40).u16(codes[0]).u16(codes.at(-1)).i16(700).i16(-200).i16(90).u16(880).u16(240)
    .u32(1).u32(0).i16(490).i16(700).u16(0).u16(32).u16(2).out;
  const post = new W().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).out;

  const strs = [[1, name], [2, 'Regular'], [3, 'AEON:' + name], [4, name], [5, 'Version 1.0'], [6, name.replace(/\s/g, '')]];
  const nw = new W().u16(0).u16(strs.length).u16(6 + strs.length * 12);
  let so = 0; const sd = new W();
  for (const [id, s] of strs) { nw.u16(3).u16(1).u16(0x409).u16(id).u16(s.length * 2).u16(so); sd.utf16(s); so += s.length * 2; }
  const nameT = new W().bytes(nw.out).bytes(sd.out).pad().out;

  const tabs = [['OS/2', os2], ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea],
    ['hmtx', hmtx], ['loca', locaT], ['maxp', maxp], ['name', nameT], ['post', post]];
  const n = tabs.length, srch = 16 * (1 << Math.floor(Math.log2(n)));
  const dir = new W().u32(0x10000).u16(n).u16(srch).u16(Math.floor(Math.log2(n))).u16(n * 16 - srch);
  let off = 12 + n * 16;
  const body = new W();
  for (const [tag, data] of tabs) {
    const pad = (4 - (data.length & 3)) & 3;
    dir.str(tag).u32(cksum(data)).u32(off).u32(data.length);
    body.bytes(data); for (let i = 0; i < pad; i++) body.u8(0);
    off += data.length + pad;
  }
  const file = new Uint8Array([...dir.out, ...body.out]);
  // head.checkSumAdjustment
  const headOff = 12 + n * 16 + tabs.slice(0, 3).reduce((a, t) => a + t[1].length + ((4 - (t[1].length & 3)) & 3), 0);
  const adj = (0xb1b0afba - cksum(file)) >>> 0;
  file[headOff + 8] = adj >>> 24; file[headOff + 9] = (adj >>> 16) & 255; file[headOff + 10] = (adj >>> 8) & 255; file[headOff + 11] = adj & 255;
  return file;
}

let cond = 1;
function makeFont(name, opts) { cond = opts.cond; return ttf(buildOutlines(opts), name); }
// ONE generated face. The HUD runs on exactly two families: this flared inscriptional roman,
// used only at 16px and up where its unhinted stems land cleanly, and Liberation Sans Narrow
// (a real, hinted condensed grotesque that ships with the OS) for every label and numeral.
// A synthesised face has no hinting, which is precisely why nothing small is set in it.
const FACES = { 'Aeon Display': { stem: 82, cond: 1, flare: .20, serif: true } };


// Generated once per page and handed to FontFace. `display:'block'` keeps the HUD from flashing
// an OS serif in the first frames; the CSS stack still names fallbacks in case a browser
// rejects the binary.
let fontsDone = false;
function installFonts() {
  if (fontsDone || typeof FontFace === 'undefined') return;
  fontsDone = true;
  for (const [name, o] of Object.entries(FACES)) {
    try {
      const f = new FontFace(name, makeFont(name, o), { display: 'block' });
      f.load().then(x => document.fonts.add(x), e => console.warn('[hud] font', name, e));
    } catch (e) { console.warn('[hud] font', name, e); }
  }
}

// ---------------------------------------------------------------------------- icon set
// One 24-unit grid, one 45-degree key light, one metaphor per glyph — no mark is reused for two
// concepts. Each icon is drawn three times from the same path data: a fat dark keyline behind
// the shape so it survives on a bright hillside, a rim light one unit below it, then the shape
// in currentColor. That is what makes a flat SVG read as a struck plaque instead of clip-art,
// and it costs one template literal.
const svg = d => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><g fill-rule="evenodd"><g class="k">${d}</g><g class="r">${d}</g><g class="f">${d}</g></g></svg>`;
const cir = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
const dk = (d, o = .45) => `<path d="${d}" fill="#000" opacity="${o}"/>`;
const P = {
  // --- yields -------------------------------------------------------------
  science:  `<path d="M9.3 1.9h5.4v2.2h-1.2v4.2l5.2 9.6c1.4 2.6-.5 5.8-3.4 5.8H8.7c-2.9 0-4.8-3.2-3.4-5.8l5.2-9.6V4.1H9.3z"/>${cir(10.2, 17.4, 1.15)}${cir(13.4, 19.2, .85)}`,
  culture:  `<path d="M3.6 1.6h16.8v3.2H3.6z"/><path d="M2.6 20.4h18.8v3H2.6z"/><path d="M5.1 18.4h13.8v2.2H5.1z"/><path d="M7.6 5.2h2.6v13.4H7.6zM13.8 5.2h2.6v13.4h-2.6z"/><path d="M10.8 5.2h2.4v13.4h-2.4z"/>`,
  faith:    `<path d="M12 1.6c3.7 4.3 5.6 7 5.6 9.9 0 3.3-2.5 5.6-5.6 5.6s-5.6-2.3-5.6-5.6c0-2.9 1.9-5.6 5.6-9.9zm0 5.2c-1.6 2.2-2.3 3.4-2.3 4.6 0 1.4 1 2.3 2.3 2.3s2.3-.9 2.3-2.3c0-1.2-.7-2.4-2.3-4.6z"/><path d="M6.3 18.2h11.4l1.6 4.1H4.7z"/>`,
  gold:     `<path d="M12 2.3c4 0 7.2 1.5 7.2 3.3S16 8.9 12 8.9 4.8 7.4 4.8 5.6 8 2.3 12 2.3z"/><path d="M4.8 8v3.4c0 1.8 3.2 3.3 7.2 3.3s7.2-1.5 7.2-3.3V8c-1.3 1.4-4 2.3-7.2 2.3S6.1 9.4 4.8 8z"/><path d="M4.8 13.8v3.4c0 1.8 3.2 3.3 7.2 3.3s7.2-1.5 7.2-3.3v-3.4c-1.3 1.4-4 2.3-7.2 2.3s-5.9-.9-7.2-2.3z"/>`,
  food:     `<path d="M11.2 22V9.6h1.6V22z"/><path d="M11.6 9.9C9 8.4 7.4 6 6.9 2.7c3.3.6 5.3 2.7 6 6.3zM12.4 9.9c2.6-1.5 4.2-3.9 4.7-7.2-3.3.6-5.3 2.7-6 6.3zM11.6 15.4c-2.6-1.5-4.2-3.9-4.7-7.2 3.3.6 5.3 2.7 6 6.3zM12.4 15.4c2.6-1.5 4.2-3.9 4.7-7.2-3.3.6-5.3 2.7-6 6.3z"/>`,
  prod:     `<path d="M14.6 1.9 22 9.3l-3.1 3.1-7.4-7.4z"/><path d="m11.9 6.8 5.3 5.3-8.4 8.4a2.1 2.1 0 0 1-3-3z"/><path d="M2 20.9h9.4v2.2H2z"/>`,
  // --- chrome -------------------------------------------------------------
  laurel:   `<path d="M11.3 22.6C6.8 20 4.1 15.9 4.1 10.9c0-2.9.8-5.6 2.4-7.9l2.3 1.6c-1.2 1.8-1.9 4-1.9 6.3 0 4 2.1 7.4 5.4 9.4zM12.7 22.6c4.5-2.6 7.2-6.7 7.2-11.7 0-2.9-.8-5.6-2.4-7.9l-2.3 1.6c1.2 1.8 1.9 4 1.9 6.3 0 4-2.1 7.4-5.4 9.4z"/><path d="M8.2 9.2C6.1 9.1 4.6 8 4.1 6c2.2-.5 3.9.3 4.9 2.1zM15.8 9.2c2.1-.1 3.6-1.2 4.1-3.2-2.2-.5-3.9.3-4.9 2.1zM9 14c-2.1-.1-3.6-1.2-4.1-3.2 2.2-.5 3.9.3 4.9 2.1zM15 14c2.1-.1 3.6-1.2 4.1-3.2-2.2-.5-3.9.3-4.9 2.1zM10.2 18.3c-2-.3-3.2-1.5-3.5-3.4 2.2-.2 3.7.8 4.3 2.5zM13.8 18.3c2-.3 3.2-1.5 3.5-3.4-2.2-.2-3.7.8-4.3 2.5z"/>`,
  crest:    `<path d="M12 1.4 3.6 4.6v7.9c0 5.2 3.4 9.3 8.4 11.1 5-1.8 8.4-5.9 8.4-11.1V4.6zm0 2.3 6.2 2.4v6.4c0 3.9-2.4 7-6.2 8.5-3.8-1.5-6.2-4.6-6.2-8.5V6.1z"/><path d="m12 6.6 1.4 3 3.2.4-2.4 2.3.6 3.2-2.8-1.6-2.8 1.6.6-3.2-2.4-2.3 3.2-.4z"/>`,
  tech:     `<path d="M5.1 3.4a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4zM5.1 15.2a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4zM17.7 8.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z"/><path d="m6.6 6.6 8.4 3.4-.7 1.7L5.9 8.3zM5.9 15.7l8.4-3.4.7 1.7-8.4 3.4z"/>`,
  plus:     `<path d="M10.8 4.6h2.4v14.8h-2.4z"/><path d="M4.6 10.8h14.8v2.4H4.6z"/>`,
  minus:    `<path d="M4.6 10.8h14.8v2.4H4.6z"/>`,
  close:    `<path d="m5.6 3.9 14.5 14.5-1.7 1.7L3.9 5.6z"/><path d="M18.4 3.9 20.1 5.6 5.6 20.1 3.9 18.4z"/>`,
  chev:     `<path d="m8.4 2.6 9.4 9.4-9.4 9.4-2.8-2.8L12.2 12 5.6 5.4z"/>`,
  check:    `<path d="m9.6 15.7 9-9 2.1 2.1-11.1 11.1-6-6 2.1-2.1z"/>`,
  lock:     `<path d="M12 1.6c3.4 0 5.6 2.2 5.6 5.4v3.4h-2.8V7c0-1.7-1.1-2.7-2.8-2.7S9.2 5.3 9.2 7v3.4H6.4V7c0-3.2 2.2-5.4 5.6-5.4z"/><path d="M4.9 10.4h14.2v11.9H4.9z"/>${dk('M10.6 14.4h2.8v4.4h-2.8z', .5)}`,
  star:     `<path d="m12 2.1 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z"/>`,
  compass:  `<path d="M12 1.9a10.1 10.1 0 1 1 0 20.2 10.1 10.1 0 0 1 0-20.2zm0 2.2a7.9 7.9 0 1 0 0 15.8 7.9 7.9 0 0 0 0-15.8z"/><path d="m12 5.2 2.6 6.8L12 18.8 9.4 12z"/>${dk('m12 5.2 2.6 6.8L12 18.8z', .42)}<path d="M11 .4h2v3.2h-2zM11 20.4h2v3.2h-2zM20.4 11h3.2v2h-3.2zM.4 11h3.2v2H.4z"/>`,
  // --- unit / city stats and orders ---------------------------------------
  // MOV: a side boot — shaft, instep, sole slab, heel notch. Nothing else on the grid has a
  // horizontal slab under a vertical block, which is what carries it at 1x.
  boot:     `<path d="M6.1 1.6h5.4v11.2H6.1z"/><path d="M6.1 11.2h6.1c5.6 0 9.4 2.9 10.2 7.6l.2 1.2H6.1z"/><path d="M3.4 19.1h19c.9 0 1.5.7 1.5 1.6v1.7H3.4z"/>${dk('M5.2 1.6h7.2v2.6H5.2z', .55)}${dk('M12.6 14.6c3.3.6 5.4 2.3 6.2 5h-6.2z', .4)}${dk('M3.4 15.9h3v3.2h-3z', .5)}`,
  // STR: an upright arming sword, guard and pommel included so it cannot be read as a dagger.
  sword:    `<path d="M12 .6 15.9 6.4v8.1H8.1V6.4z"/>${dk('M11.3 6.4h1.4v8.1h-1.4z', .45)}<path d="M3.4 14.4h17.2v3.2H3.4z"/>${dk('M3.4 16.4h17.2v1.2H3.4z', .35)}<path d="M10.3 17.8h3.4v3.2h-3.4z"/><path d="M12 19.6a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z"/>`,
  // RNG: a shot that arcs to a distant mark. No rings anywhere on the grid.
  arc:      `<path d="M1.4 21.9C4.4 10.6 11.4 4.4 21.9 4.9l-.3 3.4C12.7 7.9 6.6 13.2 4.2 22.4z"/><path d="m16.9.6 6.9 5.6-7.1 5.4.5-5.4z"/>${dk('M2.4 22.2 1.4 21.9C2.3 18.8 3.4 16.1 4.8 13.9z', .35)}<path d="M1.9 17.1h2.6v2.6H1.9z"/>`,
  // ATTACK: one blade coming down on the target with the impact chipping off it. Asymmetric on
  // purpose — two crossed triangles is what read as a bowtie last time.
  attack:   `<path d="m18.4 1.4 4.2.2-.2 4.2-9.7 9.7-4-4z"/>${dk('m19.9 3.9 1.2 1.2-8.4 8.4-1.2-1.2z', .3)}<path d="m11.6 13.4 4 4-2.8 2.8-4-4z"/><path d="m9.4 17.9 4 4-1.9 1.9-4-4z"/><path d="m2.4 3.6 4.1 1.5-1.1 2.1zM1.2 9.4l4.3-.4-.4 2.4zM5.9 1l2.2 3.7-2.2.8z"/>`,
  fortify:  `<path d="M12 1.4 3.6 4.6v7.9c0 5.2 3.4 9.3 8.4 11.1 5-1.8 8.4-5.9 8.4-11.1V4.6z"/>${dk('m8.2 10.4 3.8 3.3 3.8-3.3 1.4 1.6-5.2 4.5-5.2-4.5z', .45)}`,
  found:    `<path d="M12 3.1 2.6 11h2.6v10.6h13.6V11h2.6z"/>${dk('M9.4 14.4h5.2v7.2H9.4z', .45)}<path d="M12.9 1.1v4.6l4.4-2.3z"/>`,
  // BUILD: mallet and chisel. A modern adjustable wrench in a 4000 BC HUD was the tell.
  build:    `<path d="M1.4 1.9h11.2v7.2H1.4z"/>${dk('M9.9 1.9h2.7v7.2H9.9z', .5)}${dk('M1.4 6.9h11.2v2.2H1.4z', .3)}<path d="M5.6 8.9h3.2v13.4H5.6z"/><path d="m18.4 8.9 3.6 3.6-4.9 4.9-3.6-3.6z"/>${dk('m17.6 9.7 3.6 3.6-1.2 1.2-3.6-3.6z', .4)}<path d="m13 15.1 3.6 3.6-6 2.4z"/>`,
  produce:  `<path d="M14.6 1.9 22 9.3l-3.1 3.1-7.4-7.4z"/><path d="m11.9 6.8 5.3 5.3-8.4 8.4a2.1 2.1 0 0 1-3-3z"/>`,
  buy:      `<path d="M9.4 1.9a5.3 5.3 0 1 1 0 10.6 5.3 5.3 0 0 1 0-10.6zm0 2.2a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2z"/><path d="M2.4 14.6h5.4l4.9 2.4h4.6c1.5 0 2.6.9 2.6 2.1 0 1.3-1.1 2.2-2.6 2.2H7.8l-5.4-2.1z"/>`,
  manage:   `<path d="M8.4 2.6a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4zM16.4 4.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z"/><path d="M8.4 10.4c3.6 0 6.1 2.2 6.6 5.9l.4 4.9H1.4l.4-4.9c.5-3.7 3-5.9 6.6-5.9zM16.4 10.9c3 0 5 1.9 5.4 5l.3 4.3h-4.6l-.4-4.9c-.2-1.7-.7-3.2-1.6-4.4z"/>`,
  bombard:  `<path d="M2.4 17.4h19.2v2.4H2.4z"/><path d="m4.6 16.9 1.9-9.8 12.1 2.4-1.4 7.4z"/><path d="M6.9 3.1 20.4 5.8l-.4 2.1L6.5 5.2z"/>${cir(5.4, 20.9, 2.1)}${cir(18.6, 20.9, 2.1)}`,
  person:   `<path d="M12 2.3a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2z"/><path d="M12 10.7c4.2 0 7.2 2.6 7.7 6.9l.4 4.1H3.9l.4-4.1c.5-4.3 3.5-6.9 7.7-6.9z"/>`,
  // --- technologies (one glyph per concept) --------------------------------
  amphora:  `<path d="M9.1 1.9h5.8v2.4H9.1z"/><path d="M9.4 4.6h5.2c0 2 1 3.1 2.4 4.5 1.6 1.6 2.4 3.4 2.4 5.8 0 4.2-3.1 7.1-7.4 7.1s-7.4-2.9-7.4-7.1c0-2.4.8-4.2 2.4-5.8 1.4-1.4 2.4-2.5 2.4-4.5z"/><path d="M6.4 6.4 3.1 9.6l1.6 1.6 2.7-2.7zM17.6 6.4l3.3 3.2-1.6 1.6-2.7-2.7z"/>`,
  horse:    `<path d="M20.9 4.1c-.4 2.6-2 4.4-4.6 5.6-2.2 1-3.6 2.5-4.4 4.6l-1.6 4.8c-.4 1.2-1.2 2-2.6 2.4l-4.6 1.2 1.2-3.6c.6-1.8.5-3.4-.4-5.1L2.2 10c-.6-1.2-.4-2.3.6-3.1l2.4-2 1.6 2.6 3.1-2.4-1.2-2.6 4.1 1.4c1.6.6 3 .5 4.3-.3z"/>`,
  pickaxe:  `<path d="M12 4.4c4.4-3.4 9.9-2.9 9.9-2.9s-2.4 4.8-8.1 5.6zM12 4.4C7.6 1 2.1 1.5 2.1 1.5s2.4 4.8 8.1 5.6z"/><path d="M10.6 6.1h2.8v16h-2.8z"/>`,
  bow:      `<path d="M5.4 1.9C11.9 3.4 17.2 8.7 18.7 15.2l-2.4.6C15 10.1 10.5 5.6 4.8 4.3z"/><path d="M4.6 1.6 8.4 2.4 3.9 6.9 3.1 3.1z"/><path d="m3.4 20.9 16-16 1.7 1.7-16 16z"/><path d="M22.4 1.6 21.6 5.4 18.1 1.9z"/>`,
  sail:     `<path d="M11.1 1.4v13.2H4.4z"/><path d="M12.9 5.1v9.5h5.6z"/><path d="M1.4 16.4h21.2l-2.9 4.9c-.5.9-1.4 1.3-2.4 1.3H6.7c-1 0-1.9-.4-2.4-1.3z"/>`,
  quill:    `<path d="M21.6 1.6c-8.4.5-13.6 3.9-15.6 10.2l-1 3.1 3.4 3.4 3.1-1c6.3-2 9.6-7.2 10.1-15.7z"/><path d="m2.1 21.9 6.1-8.4 1.4 1.4-7.5 7z"/>`,
  bricks:   `<path d="M2.1 3.4h8.4v5.1H2.1zM12.3 3.4h9.6v5.1h-9.6zM2.1 10.3h5.4v5.1H2.1zM9.3 10.3h9.6v5.1H9.3zM20.7 10.3h1.2v5.1h-1.2zM2.1 17.2h11.4v5.1H2.1zM15.3 17.2h6.6v5.1h-6.6z"/>`,
  spear:    `<path d="M12 1.1 15.4 8c.6 1.2.4 2.4-.6 3.3L12 13.6 9.2 11.3c-1-.9-1.2-2.1-.6-3.3z"/><path d="M11.1 12.9h1.8v10h-1.8z"/>`,
  wheel:    `<path d="M12 1.9a10.1 10.1 0 1 1 0 20.2 10.1 10.1 0 0 1 0-20.2zm0 2.4a7.7 7.7 0 1 0 0 15.4 7.7 7.7 0 0 0 0-15.4z"/><path d="M11 4.9h2v14.2h-2z"/><path d="M4.9 11h14.2v2H4.9z"/><path d="m6.9 5.5 11.6 11.6-1.4 1.4L5.5 6.9z"/><path d="M17.1 5.5 18.5 6.9 6.9 18.5 5.5 17.1z"/>${cir(12, 12, 2.3)}`,
  canal:    `<path d="M2.1 8.4h19.8v2.6H2.1z"/><path d="M4.9 11.6h2.4v9.9H4.9zM10.8 11.6h2.4v9.9h-2.4zM16.7 11.6h2.4v9.9h-2.4z"/><path d="M12 1.4c2.2 2.7 3.3 4.4 3.3 5.8 0 1.9-1.5 3.2-3.3 3.2s-3.3-1.3-3.3-3.2c0-1.4 1.1-3.1 3.3-5.8z"/>`,
  rider:    `<path d="M12 1.6a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8z"/><path d="M20.4 8.4c-.6 2.4-2.2 3.9-4.8 4.8-1.9.7-3.1 1.9-3.8 3.6l-1.4 3.6c-.4 1-1.1 1.6-2.2 1.9l-4.6 1.1 1.2-3.4c.5-1.5.4-2.9-.3-4.3l-1.4-2.6 2.6-2.1 1.4 2.1 3.4-2.1-1-2.1z"/>`,
  anvil:    `<path d="M2.4 6.9h11.1c0 2.4 1.4 3.9 4.1 4.4l4-1v3.1c0 2.4-2.1 3.9-5.4 3.9H8.6l1.4-3.1H6.4c-2.6 0-4-1.4-4-3.6z"/><path d="M7.4 18.6h9.2l1.9 3.6H5.5z"/>`,
  scales:   `<path d="M11 2.4h2v19.1h-2z"/><path d="M5.6 21.6h12.8v1.9H5.6z"/><path d="M3.4 5.4h17.2v1.9H3.4z"/><path d="M6.4 7.9 10.1 16H2.7zM17.6 7.9 21.3 16h-7.4z"/>`,
  dividers: `<path d="M12 1.4a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z"/><path d="m10.6 5.9 2.2.9-5.6 15.6-3.4-1.2z"/><path d="m13.4 5.9-2.2.9 5.6 15.6 3.4-1.2z"/>`,
  owl:      `<path d="M12 2.6c5 0 8.4 3.7 8.4 9.1 0 5.9-3.6 10.1-8.4 10.1S3.6 17.6 3.6 11.7c0-5.4 3.4-9.1 8.4-9.1z"/>${dk('M8.4 8.6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm7.2 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6z', .5)}${dk('m12 13.4 1.9 2.6h-3.8z', .5)}<path d="M3.9 2.1 8.1 6 5 7.6zM20.1 2.1 15.9 6l3.1 1.6z"/>`,
  arch:     `<path d="M2.1 21.9V6.6h19.8v15.3h-4.6V12c0-2.9-2.3-5-5.3-5s-5.3 2.1-5.3 5v9.9z"/><path d="M1.1 3.4h21.8v2.6H1.1z"/>`,
  knight:   `<path d="M12 1.6c4.6 0 7.4 3 7.4 7.6 0 2.4-.6 4.1-1.9 5.9l.9 7.4H5.6l.9-7.4c-1.3-1.8-1.9-3.5-1.9-5.9 0-4.6 2.8-7.6 7.4-7.6z"/>${dk('M7.9 8.6h8.2v2.6H7.9z', .5)}${dk('M11.1 12.4h1.8v4.4h-1.8z', .5)}`,
  gear:     `<path d="M10.4 1.4h3.2l.5 3a7.7 7.7 0 0 1 2 .8l2.4-1.8 2.3 2.3-1.8 2.4c.4.6.6 1.3.8 2l3 .5v3.2l-3 .5c-.2.7-.4 1.4-.8 2l1.8 2.4-2.3 2.3-2.4-1.8c-.6.4-1.3.6-2 .8l-.5 3h-3.2l-.5-3a7.7 7.7 0 0 1-2-.8l-2.4 1.8-2.3-2.3 1.8-2.4a7.7 7.7 0 0 1-.8-2l-3-.5v-3.2l3-.5c.2-.7.4-1.4.8-2L3.2 5.7l2.3-2.3 2.4 1.8c.6-.4 1.3-.6 2-.8zM12 8.1a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8z"/>`,
  banner:   `<path d="M3.4 1.4h2.4v21.2H3.4z"/><path d="M6.6 2.4h14.6l-3.4 4.9 3.4 4.9H6.6z"/>`,
  // ASTRONOMY: an armillary sphere. The old concentric-ring mark is gone from the set entirely.
  astro:    `<path d="M12 1.6a10.4 10.4 0 1 1 0 20.8 10.4 10.4 0 0 1 0-20.8zm0 2.4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/><path d="M12 7.9c5.6 0 9.9 1.8 9.9 4.1S17.6 16.1 12 16.1 2.1 14.3 2.1 12 6.4 7.9 12 7.9zm0 1.9c-4.4 0-8 1.1-8 2.2s3.6 2.2 8 2.2 8-1.1 8-2.2-3.6-2.2-8-2.2z"/><path d="m4.4 3.4 16.2 17-1.8 1.6L2.7 5z"/>${cir(12, 12, 2)}`,
  book:     `<path d="M2.1 4.1c2.9-1.4 6.2-1.6 9.9-.6v16.4c-3.7-1-7-.8-9.9.6z"/><path d="M21.9 4.1c-2.9-1.4-6.2-1.6-9.9-.6v16.4c3.7-1 7-.8 9.9.6z"/>`,
  crossbow: `<path d="M2.6 3.1 5.4 2c1.9 4.6 5.4 7.6 10.4 8.9l-.6 2.6C9.2 12 4.9 8.5 2.6 3.1zM21.4 3.1 18.6 2c-1.9 4.6-5.4 7.6-10.4 8.9l.6 2.6c6-1.5 10.3-5 12.6-10.4z"/><path d="M10.9 6.6h2.2v15.8h-2.2z"/><path d="M6.9 12.4h10.2v2.4H6.9z"/>`,
  vault:    `<path d="M2.4 3.4h19.2v17.2H2.4zm2.4 2.4v12.4h14.4V5.8z"/><path d="M12 6.9a5.1 5.1 0 1 1 0 10.2 5.1 5.1 0 0 1 0-10.2zm0 2.2a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8z"/><path d="M11.1 4.4h1.8v3.1h-1.8zM11.1 16.5h1.8v3.1h-1.8zM4.9 11.1h3.1v1.8H4.9zM16 11.1h3.1v1.8H16z"/>`,
  guild:    `<path d="M12 1.6 21.9 8v2.6L12 4.4 2.1 10.6V8z"/><path d="m5.6 12.4 6.4 4 6.4-4 1.4 2.1-7.8 4.9-7.8-4.9z"/><path d="M11.1 6.4h1.8v13.9h-1.8z"/><path d="M4.4 19.6h15.2v2.6H4.4z"/>`,
  press:    `<path d="M4.1 1.9h15.8v4.4H4.1z"/><path d="M6.9 6.6h10.2v3.9H6.9z"/><path d="M2.4 10.9h19.2v4.4H2.4z"/><path d="M5.4 15.6h13.2v6.6H5.4z"/>${dk('M8.4 17.4h7.2v3.1H8.4z', .45)}`,
  cannon:   `<path d="m3.4 9.4 15.1-4.1 1.3 4.8-15.1 4z"/><path d="m19.4 4.6 3.4-.9.9 3.4-3.4.9z"/><path d="M2.1 18.9h19.8v2.6H2.1z"/><path d="m4.6 13.6 12.4-3.3 1 3.6-12.4 3.4z"/>${cir(6.4, 18.4, 2.6)}`,
  crucible: `<path d="M4.9 3.4h9.6c0 3.6 2.4 5.9 6.6 6.4l-1 3.4c-4.4-.4-7.6-2.2-9.4-5.4z"/><path d="M6.4 10.4h11.2l-1.6 8.4c-.3 1.9-1.6 3-3.6 3h-1c-2 0-3.3-1.1-3.6-3z"/><path d="M18.9 2.1c1 1.4 1.4 2.5 1.4 3.4 0 1.2-.9 2-2 2s-2-.8-2-2c0-.9.5-2 2.6-3.4z"/>`,
  ledger:   `<path d="M3.9 1.9h16.2v20.2H3.9z"/>${dk('M6.6 5.4h10.8v1.8H6.6z', .45)}${dk('m6.9 17.4 3.6-4.9 2.9 2.6 4.1-6.1 1.6 1.4-5.4 8-3-2.6-2.4 3.1z', .5)}`,
  fountain: `<path d="M2.1 20.4h19.8v2.4H2.1z"/><path d="M6.4 12.9h11.2l-1.4 7.1H7.8z"/><path d="M11.1 5.4h1.8v7.1h-1.8z"/><path d="M12 1.4c1.9 2.2 2.9 3.6 2.9 4.8 0 1.6-1.3 2.7-2.9 2.7s-2.9-1.1-2.9-2.7c0-1.2 1-2.6 2.9-4.8z"/><path d="M4.4 9.6c1.6.4 2.6 1.6 3.1 3.4l-2.4.6c-.3-1.2-.8-1.9-1.7-2.2zM19.6 9.6c-1.6.4-2.6 1.6-3.1 3.4l2.4.6c.3-1.2.8-1.9 1.7-2.2z"/>`,
  factory:  `<path d="M2.1 21.9V9.4l6.4 3.9V9.4l6.4 3.9V4.1h6.9v17.8z"/><path d="M4.6 1.4h3.6v6.1L4.6 5.6z"/>`,
  rail:     `<path d="M4.4 1.9h2.6v20.2H4.4zM17 1.9h2.6v20.2H17z"/><path d="M2.1 4.9h19.8v2.4H2.1zM2.1 10.8h19.8v2.4H2.1zM2.1 16.7h19.8v2.4H2.1z"/>`,
  scroll:   `<path d="M6.4 1.9h13.1c1.4 0 2.4 1.1 2.4 2.6v15c0 1.5-1 2.6-2.4 2.6H6.4c-1.4 0-2.4-1.1-2.4-2.6V4.5c0-1.5 1-2.6 2.4-2.6z"/>${dk('M7.4 6.4h9.2v1.8H7.4zM7.4 10.4h9.2v1.8H7.4zM7.4 14.4h6v1.8h-6z', .45)}`,
  city:     `<path d="M1.9 20.4h20.2v2.4H1.9z"/><path d="M4.4 20.1v-9.4L8.6 8l4.2 2.7v9.4z"/><path d="M13.6 20.1v-6.4l4.1-2.4 3.4 2v6.8z"/>${dk('M7.1 16.4h3v3.7h-3z', .45)}<path d="M7.9 2.1 12.9 4l-5 1.9z"/><path d="M7.6 1.4h1.4v7.1H7.6z"/>`,
  growth:   `<path d="M21.4 2.6C11.4 2.4 4.6 6.8 3.6 13.6c-.5 3.2.6 5.9 2.7 7.7 4.9-7.3 8.9-10.6 15.1-18.7z"/><path d="M5.6 21.9C7.5 15 12.2 9 20.1 3.8l1 1.4C13.6 10.2 9.2 15.8 7.4 22.4z"/>`,
  anchor:   `<path d="M12 1.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z"/><path d="M11 6.9h2v15.4h-2z"/><path d="M7.1 8.4h9.8v2.2H7.1z"/><path d="M3.4 13.4c0 4.9 3.9 8 8.6 8s8.6-3.1 8.6-8h-2.4c0 3.4-2.8 5.6-6.2 5.6s-6.2-2.2-6.2-5.6z"/>`,
};
const ICON = {}; for (const k in P) ICON[k] = svg(P[k]);
ICON.wheat = ICON.food;   // one grain glyph, two contexts (agriculture tech / food yield)

// What a technology puts in your hands. Every entry points at a glyph that already exists, so
// the unlock strip on a tech card is real information rather than a row of generic dots.
const UNLOCK_ICON = {
  settler: 'person', scout: 'boot', warrior: 'sword', archer: 'bow', spearman: 'spear',
  horseman: 'horse', swordsman: 'sword', catapult: 'bombard', pikeman: 'spear', knight: 'knight',
  crossbowman: 'crossbow', trebuchet: 'bombard', musketman: 'cannon', cannon: 'cannon',
  rifleman: 'cannon', galley: 'sail', quinquereme: 'sail', caravel: 'sail', frigate: 'cannon',
  ironclad: 'anchor', monument: 'arch', granary: 'amphora', walls: 'bricks', barracks: 'spear',
  library: 'book', harbor: 'anchor', market: 'scales', temple: 'faith', encampment: 'banner',
  aqueduct: 'canal', workshop: 'anvil', campus: 'owl', university: 'book', bank: 'vault',
  observatory: 'astro', press: 'press', sewer: 'fountain', stock: 'ledger', factory: 'factory',
  rail_yard: 'rail',
};

// Leader cameos. Right-facing profiles: at 40px a profile carries a brow, a nose and a jaw,
// where a front-on bust collapses into the blank avatar silhouette every placeholder ships with.
// One head-and-shoulders path, four sets of headgear, so four rulers read as four people.
const PROFILE = 'M4 64q3-10 21-13l2-6q-14-3-13-16Q12 7 33 6q13 1 12 13l-1 4 7 8-7 3 2 3-3 3q-2 6-10 7l1 4q19 3 24 13z';
// the lit edge of the face, traced as a rim light — the single thing that stops a silhouette
// reading as a blank avatar at 40px
const RIM = '<path d="M45 19l-1 4 7 8-7 3 2 3-3 3q-2 6-10 7" fill="none" stroke="#fff4d6" stroke-opacity=".6" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
const BROW = '<path d="M38 21q4-1 6 1l-1 3q-3-2-6-1z" fill="#0d0a05" opacity=".75"/><path d="M41 37q3 0 5 1-2 2-5 1z" fill="#0d0a05" opacity=".55"/>';
const GEAR = [
  // laurel crown — thin wreath low on the skull, leaves breaking the silhouette behind
  `<path d="M10 27q6-15 22-16 12 0 15 10l-4 3q-3-7-11-7-13 1-18 13z"/><path d="M3 25q5-7 12-4-5 6-12 4zM6 13q4-7 12-5-4 7-12 5zM15 4q5-5 12-3-4 7-12 3z"/>`,
  // horned war-helm — full skullcap, brow bar clear of the eye, horn sweeping up and back
  `<path d="M11 30Q8 5 31 4q17 0 16 18l-6 2q1-12-11-12Q17 12 17 30z"/><path d="M10 13h24l1 6H11z"/><path d="M13 13Q1 11 3 0q6 5 7 12z"/>`,
  // veiled diadem — cloth falling behind the skull to the shoulder, jewelled band on the brow
  `<path d="M11 27Q8 4 31 4q15 0 15 15l-2 4-5-2q0-9-8-9-11 0-11 13z"/><path d="M12 19q-7 15-5 29l-8 2q-2-19 7-33z"/><path d="M11 12h27l-1 6H12z"/><path d="M20 13h4v4h-4zM28 13h4v4h-4z" fill="#000" opacity=".5"/>`,
  // plumed helm — tall crest over the crown, cheekpiece down the jaw
  `<path d="M11 29Q8 5 31 4q17 0 16 17l-6 2Q42 11 31 11 16 11 17 29z"/><path d="M15 27h9v13q0 4-4 4t-5-4z"/><path d="M19 7q7-9 17-6-3 4-1 8-8-3-14 2z"/><path d="M22 4q8-6 15-1-6 0-9 4z"/>`,
];
const cameo = (i, c) => `<svg viewBox="2 4 60 60" preserveAspectRatio="xMidYMax slice">
 <rect x="0" y="0" width="64" height="64" fill="${c}" opacity=".34"/><rect width="64" height="64" fill="url(#cv)"/>
 <g fill="#060502" opacity=".65" transform="translate(1.8 1.8)"><path d="${PROFILE}"/>${GEAR[i % 4]}</g>
 <g fill="url(#cg)"><path d="${PROFILE}"/>${GEAR[i % 4]}</g>
 <rect width="64" height="64" fill="url(#csh)" clip-path="url(#cc)"/>
 ${BROW}${RIM}
 <defs><clipPath id="cc"><path d="${PROFILE}"/></clipPath>
 <linearGradient id="csh" x1="0" y1="0" x2="1" y2="0"><stop offset=".1" stop-color="#000" stop-opacity=".62"/><stop offset=".62" stop-color="#000" stop-opacity="0"/></linearGradient>
 <radialGradient id="cv" cx=".66" cy=".26" r=".85"><stop offset=".18" stop-color="#000" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".9"/></radialGradient>
 <linearGradient id="cg" x1=".88" y1="0" x2=".18" y2="1"><stop offset="0" stop-color="#f0dcae"/><stop offset=".22" stop-color="#b39a68"/><stop offset=".48" stop-color="#6e5b39"/><stop offset=".76" stop-color="#372d1c"/><stop offset="1" stop-color="#100c07"/></linearGradient></defs></svg>`;

// Selection portraits — painted busts, not line sketches. Five tonal steps per material, a rim
// light down the camera-left edge, a cast shadow into the plate and a civ-coloured wash behind
// the figure that the panel supplies through --civ.
const BDEFS = `<defs>
 <linearGradient id="bmet" x1=".14" y1="0" x2=".92" y2=".95"><stop offset="0" stop-color="#f3e6c4"/><stop offset=".2" stop-color="#bfa576"/><stop offset=".44" stop-color="#7d683f"/><stop offset=".7" stop-color="#3e3320"/><stop offset="1" stop-color="#15110b"/></linearGradient>
 <linearGradient id="bsh" x1="0" y1="0" x2="1" y2=".22"><stop offset=".3" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".62"/></linearGradient>
 <linearGradient id="bcloth" x1=".18" y1="0" x2=".9" y2="1"><stop offset="0" stop-color="#83704c"/><stop offset=".3" stop-color="#584a30"/><stop offset=".62" stop-color="#2e2618"/><stop offset="1" stop-color="#0d0b06"/></linearGradient>
 <linearGradient id="bskin" x1=".15" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0bf8d"/><stop offset=".34" stop-color="#b08c5c"/><stop offset=".66" stop-color="#6b5232"/><stop offset="1" stop-color="#2c2114"/></linearGradient>
 <linearGradient id="bstone" x1=".1" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#cfc3a4"/><stop offset=".4" stop-color="#8b8069"/><stop offset=".75" stop-color="#4a4436"/><stop offset="1" stop-color="#211e17"/></linearGradient>
 <radialGradient id="bciv" cx=".5" cy=".36" r=".62"><stop offset="0" stop-color="var(--civ,#4fa8ff)" stop-opacity=".3"/><stop offset="1" stop-color="var(--civ,#4fa8ff)" stop-opacity="0"/></radialGradient>
 <radialGradient id="bvig" cx=".48" cy=".34" r=".76"><stop offset=".42" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".78"/></radialGradient>
</defs>`;
const bust = i => `<svg viewBox="0 0 100 108" class="bust">${BDEFS}<rect width="100" height="108" fill="#14110c"/><rect width="100" height="108" fill="url(#bciv)"/>${i}<rect width="100" height="108" fill="url(#bvig)"/></svg>`;
const PORTRAIT = {
  // Helmeted soldier, three-quarter to camera-left. Values: highlight crest, lit cheek of the
  // helm, mid bronze, shadowed right side, black interior of the eye slots.
  unit: bust(`
 <ellipse cx="52" cy="104" rx="46" ry="10" fill="#000" opacity=".6"/>
 <path d="M1 108c3-20 15-32 35-36l14-4 14 4c20 4 32 16 35 36z" fill="url(#bcloth)"/>
 <path d="M50 68 78 78l-6 30H28l-6-30z" fill="var(--civ,#c8452f)" opacity=".92"/>
 <path d="M50 68 78 78l-6 30H28l-6-30z" fill="url(#bsh)"/>
 <path d="M50 68 78 78l-2 8-26-10-26 10-2-8z" fill="#000" opacity=".45"/>
 <path d="m50 68 5 2-4 38h-4z" fill="#fff" opacity=".2"/>
 <path d="M15 100c5-11 13-18 24-22l-2 10c-7 3-13 8-16 14z" fill="#e3caa0" opacity=".42"/>
 <path d="M1 108c3-20 15-32 35-36l2 5c-17 5-27 16-30 31z" fill="#f4e6c4" opacity=".3"/>
 <path d="M67 78c9 5 15 12 18 22l-10 5c-3-8-8-14-14-18z" fill="#000" opacity=".45"/>
 <path d="M43 60h14v16c0 5-14 5-14 0z" fill="url(#bskin)"/>
 <path d="M43 60h14v8c-5 4-11 4-14 0z" fill="#000" opacity=".6"/>
 <g transform="translate(50 44) scale(.94) translate(-50 -44)">
 <path d="M50 12c-16 0-27 12-27 29 0 11 3 20 8 26l3 4c3 4 8 6 16 6s13-2 16-6l3-4c5-6 8-15 8-26 0-17-11-29-27-29z" fill="url(#bmet)"/>
 <path d="M50 12c-16 0-27 12-27 29 0 11 3 20 8 26l3 4c3 4 8 6 16 6s13-2 16-6l3-4c5-6 8-15 8-26 0-17-11-29-27-29z" fill="url(#bsh)"/>
 <path d="M29 25c4-6 10-10 18-11-9 3-14 9-16 17z" fill="#fdf5df" opacity=".6"/>
 <path d="M23 41c0-14 6-24 17-28-9 6-13 15-13 28 0 10 2 19 6 25l-4 5c-4-8-6-18-6-30z" fill="#fff6dc" opacity=".5"/>
 <path d="M25 38c8-5 16-7 25-7s17 2 25 7l-1 7c-8-5-16-7-24-7s-16 2-24 7z" fill="#8e7749"/>
 <path d="M25 38c8-5 16-7 25-7v3.4c-8 0-16 2-24 7z" fill="#fbf0d2" opacity=".55"/>
 <path d="M26 47c5-3 11-5 18-5v9c-7 0-14 2-19 5z" fill="#0b0805"/>
 <path d="M74 47c-5-3-11-5-18-5v9c7 0 14 2 19 5z" fill="#0b0805"/>
 <path d="M47 42h6v14h-6z" fill="#0b0805"/>
 <path d="M47 42h2v14h-2z" fill="#c9b184" opacity=".5"/>
 <path d="M31 60c6 4 12 6 19 6s13-2 19-6l-2 8c-5 3-10 5-17 5s-12-2-17-5z" fill="#000" opacity=".5"/>
 <path d="M33 66c5 3 11 4 17 4s12-1 17-4l2 6c-5 4-11 6-19 6s-14-2-19-6z" fill="#5f4e2f"/>
 <path d="M33 66c5 3 11 4 17 4v2.6c-6 0-13-1-18-4z" fill="#e8d5aa" opacity=".45"/>
 </g>`),
  // Civilian: hooded, no metal. Reads as a different silhouette at thumbnail size.
  civil: bust(`
 <ellipse cx="50" cy="103" rx="45" ry="11" fill="#000" opacity=".55"/>
 <path d="M2 108c4-21 17-33 35-38l13-5 13 5c18 5 31 17 35 38z" fill="url(#bcloth)"/>
 <path d="M12 100c5-13 15-21 28-25l-2 9c-10 4-17 10-21 19z" fill="#c6ab77" opacity=".26"/>
 <path d="M50 63c-9 0-15-4-15-11V37h30v15c0 7-6 11-15 11z" fill="url(#bskin)"/>
 <path d="M50 12c13 0 22 9 22 24 0 13-9 24-22 24s-22-11-22-24c0-15 9-24 22-24z" fill="url(#bskin)"/>
 <path d="M50 12c13 0 22 9 22 24 0 13-9 24-22 24z" fill="#000" opacity=".26"/>
 <path d="M28 32c0-15 9-25 22-25s22 10 22 25l3 17-7 3-2-17c-2-10-8-15-16-15s-15 5-17 15l-2 17-7-3z" fill="url(#bcloth)"/>
 <path d="M30 13C35 5 42 1 51 1c-9 5-14 12-17 21z" fill="#eddcb4" opacity=".38"/>
 <path d="M37 39c3-2 7-2 9 0M54 39c3-2 7-2 9 0" stroke="#1b140c" stroke-width="2.6" fill="none"/>
 <path d="M43 50c4 2 10 2 14 0-2 4-5 6-7 6s-5-2-7-6z" fill="#3a2616" opacity=".7"/>
 <path d="m50 63 16 5-9 40H43l-9-40z" fill="var(--civ,#c8452f)" opacity=".92"/>
 <path d="m50 63 4 2-6 43h-3z" fill="#fff" opacity=".22"/>
 <path d="M40 85h20l-2 10H42z" fill="#000" opacity=".35"/>`),
  // City: a walled skyline in three planes — near roofs, keep, far wall — lit from camera-left.
  city: bust(`
 <path d="M0 108V72l16-11 13 9 14-10 15 10 14-9 17 11 11-7v43z" fill="#171410"/>
 <path d="M14 108V58l17-10 17 10v50z" fill="url(#bcloth)"/>
 <path d="M14 58 31 48l3 2-17 10z" fill="#e3cd9d" opacity=".4"/>
 <path d="M46 108V38l18-12 19 12v70z" fill="url(#bstone)"/>
 <path d="M46 38 64 26l3 2-18 12z" fill="#fbf0d2" opacity=".55"/>
 <path d="M64 26v82h19V38z" fill="#000" opacity=".28"/>
 <path d="M20 66h7v12h-7zM33 66h7v12h-7zM20 84h7v14h-7zM33 84h7v14h-7z" fill="#f8e2a8" opacity=".62"/>
 <path d="M52 54h7v12h-7zM66 54h7v12h-7zM52 73h7v15h-7zM66 73h7v15h-7z" fill="#f8e2a8" opacity=".5"/>
 <path d="M62 8h3v20h-3z" fill="#dcc99d"/>
 <path d="M65 8h17l-5 6 5 6H65z" fill="var(--civ,#c8452f)"/>
 <path d="M0 96h100v12H0z" fill="#000" opacity=".4"/>`),
};

// ---------------------------------------------------------------------------- content
// id -> [era, cost, blurb, icon, ...prereqs]. Era/cost/prereqs are overridden by the gameplay
// module's own table when it is loaded; the blurb and the icon are always ours — that authored
// line under each node, and one unique glyph per technology, is most of what stops a tech tree
// looking auto-generated.
const TECHDATA = {
  agriculture:      [0, 22, 'The surplus that lets a village stop moving.', 'wheat'],
  pottery:          [0, 30, 'A granary. The harvest survives the lean year.', 'amphora', 'agriculture'],
  animal_husbandry: [0, 32, 'Pasture, and the first horses on the map.', 'horse', 'agriculture'],
  mining:           [0, 34, 'Copper and iron, read out of the hillside.', 'pickaxe', 'agriculture'],
  archery:          [0, 38, 'Reach. Damage delivered from safe ground.', 'bow', 'animal_husbandry'],
  sailing:          [0, 40, 'The coast stops being a wall.', 'sail', 'pottery'],
  writing:          [0, 44, 'The first technology that compounds.', 'quill', 'pottery'],
  masonry:          [0, 46, 'Walls. A city becomes a decision to besiege.', 'bricks', 'mining'],
  bronze_working:   [0, 50, 'The spear line that breaks a charge.', 'spear', 'mining'],
  the_wheel:        [0, 54, 'Roads, and everything that runs on them.', 'wheel', 'animal_husbandry'],
  irrigation:       [1, 104, 'Floodplain silt turned into a standing surplus.', 'canal', 'pottery', 'masonry'],
  horseback_riding: [1, 112, 'A flank that arrives before the line can turn.', 'rider', 'the_wheel', 'archery'],
  iron_working:     [1, 120, 'Line infantry, and the smiths to keep them.', 'anvil', 'bronze_working'],
  currency:         [1, 127, 'Trade stops being barter.', 'scales', 'writing', 'the_wheel'],
  mathematics:      [1, 138, 'Siege arithmetic. Also the first engineers.', 'dividers', 'writing', 'masonry'],
  philosophy:       [1, 148, 'Argument as an institution rather than a quarrel.', 'owl', 'writing'],
  construction:     [1, 159, 'The arch: aqueduct, bridge, and the weight both carry.', 'arch', 'masonry', 'irrigation'],
  chivalry:         [1, 172, 'Land held in exchange for the cavalry it raises.', 'knight', 'horseback_riding', 'iron_working'],
  engineering:      [2, 304, 'Forts, and roads that survive a wet winter.', 'gear', 'construction', 'mathematics'],
  feudalism:        [2, 328, 'A pike wall the knight cannot answer.', 'banner', 'chivalry'],
  astronomy:        [2, 352, 'The sky becomes a calendar and a chart.', 'astro', 'philosophy', 'sailing'],
  education:        [2, 384, 'Knowledge outlives the man who had it.', 'book', 'philosophy', 'currency'],
  machinery:        [2, 416, 'Power that does not tire between shots.', 'crossbow', 'engineering', 'iron_working'],
  banking:          [2, 448, 'Credit outruns the treasury behind it.', 'vault', 'currency', 'education'],
  guilds:           [2, 480, 'A trade that trains its own replacements.', 'guild', 'feudalism', 'banking'],
  printing:         [2, 512, 'A library in every literate house.', 'press', 'education', 'machinery'],
  gunpowder:        [3, 798, 'The end of the armoured knight, and of the wall.', 'cannon', 'machinery', 'guilds'],
  metallurgy:       [3, 855, 'Barrels that survive their own charge.', 'crucible', 'gunpowder'],
  economics:        [3, 912, 'A state that can borrow against next year.', 'ledger', 'banking', 'printing'],
  sanitation:       [3, 969, 'The city stops killing the people it attracts.', 'fountain', 'economics', 'astronomy'],
  industrialization:[3, 1064, 'Coal, and the appetite that comes with it.', 'factory', 'metallurgy', 'economics'],
  railroad:         [3, 1178, 'Distance collapses; the interior finally opens.', 'rail', 'industrialization', 'sanitation'],
};
const ERA_NAMES = ['Ancient', 'Classical', 'Medieval', 'Industrial'];
const ERA_YEARS = ['4000 \u2013 1000 BC', '1000 BC \u2013 AD 500', 'AD 500 \u2013 1500', 'AD 1500 \u2013 1900'];
const DEMO_DONE = new Set(['agriculture', 'pottery', 'animal_husbandry', 'mining', 'archery', 'sailing', 'writing', 'masonry', 'bronze_working', 'the_wheel', 'irrigation', 'horseback_riding']);
const DEMO_NOW = 'currency';

// log line -> dispatch card. First match wins; anything unmatched is a plain dispatch.
const NOTE_KINDS = [
  [/first cities|dawn|new age|era of/i, 'A new age', 'laurel'],
  [/research|discover|learn|technolog/i, 'Research complete', 'science'],
  [/grew|grows|citizen|population/i, 'City grew', 'growth'],
  [/found|settle|rise|claims|annex/i, 'City founded', 'city'],
  [/border|culture|civic|wonder/i, 'Borders expanded', 'culture'],
  [/war|attack|batt|captur|destro|raze|lost|falls|slain/i, 'Combat report', 'attack'],
  [/complete|finish|built|trains|produc/i, 'Production complete', 'prod'],
];
const noteKind = msg => NOTE_KINDS.find(k => k[0].test(msg))?.slice(1) ?? ['Dispatch', 'scroll'];

const DEMO_CIVS = [
  { i: 0, name: 'Aeon', hex: '#4fa8ff' }, { i: 1, name: 'Korrath', hex: '#e0524a' },
  { i: 2, name: 'Meridia', hex: '#f2c14a' }, { i: 3, name: 'Vellum', hex: '#7ad6a0' },
];

const MINI_BIOME = {
  ocean: [20, 45, 72], coast: [38, 92, 124], beach: [201, 177, 137], grass: [93, 138, 69],
  plains: [147, 150, 79], desert: [200, 171, 107], tundra: [141, 145, 136], snow: [223, 230, 232],
  forest: [56, 97, 54], jungle: [45, 93, 49], hills: [111, 122, 68], mountain: [125, 116, 104],
};

const fmt = n => (Math.abs(n) >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
const sign = n => (n >= 0 ? '+' + Math.round(n) : String(Math.round(n)));
const title = s => String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const yearTxt = y => (y < 0 ? `${-y} BC` : `AD ${y}`);
const hex6 = n => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
// "Title|Body|Hotkey" — quotes stripped so a game-supplied name can never break the attribute.
const tip = (t, b, k = '') => `data-tip="${[t, b, k].join('|').replace(/"/g, '&quot;')}"`;

// [key, label, icon, tooltip title, tooltip body, hotkey]
const ACTIONS = {
  unit: [
    ['move', 'Move', 'boot', 'Move', 'Order this unit along a path. Terrain cost shows on the tile. Shift-click to queue several orders.', 'M'],
    ['fortify', 'Fortify', 'fortify', 'Fortify', 'Dig in. Defence bonus, and the unit heals while it holds.', 'F'],
    ['attack', 'Attack', 'attack', 'Attack', 'Strike an adjacent enemy. Melee attacks take return damage.', 'A'],
    ['found', 'Found', 'found', 'Found city', 'Plant a city here. Settlers only, and not inside another city claim.', 'B'],
    ['build', 'Build', 'build', 'Build', 'Improve this tile: road, fort or mine, whichever the terrain allows.', 'C'],
  ],
  city: [
    ['produce', 'Produce', 'produce', 'Production', 'Choose what this city builds next.', 'P'],
    ['buy', 'Purchase', 'buy', 'Purchase', 'Finish the current item with gold. Always worse value than building it.', 'G'],
    ['manage', 'Citizens', 'manage', 'Manage citizens', 'Reassign worked tiles and specialists.', 'M'],
    ['walls', 'Defend', 'fortify', 'Garrison', 'Station the garrison and repair the walls.', 'F'],
    ['strike', 'Bombard', 'bombard', 'Bombard', 'City ranged attack against an adjacent besieger.', 'A'],
  ],
};
const STAT_ICON = { MOV: 'boot', STR: 'sword', RNG: 'arc', XP: 'star', POP: 'person', FOOD: 'food', PROD: 'prod', SCI: 'science' };

export class HUD {
  constructor(state = {}, opts = {}) {
    installFonts();
    this.opts = opts;
    this.camera = opts.camera ?? null;
    this.map = state?.map ?? opts.map ?? null;
    this.demo = this.buildDemo();
    this.cache = {};          // last value written per DOM slot — update() runs per frame, DOM must not
    this.pose = '';
  }

  // -------------------------------------------------------------- demo model
  // Derived from the real map so the minimap markers sit on land, near rivers, spread apart —
  // roughly where a settler AI would end up. The demo also carries its own explored mask, so a
  // HUD with no gameplay module behind it still shows a fogged world rather than a solved one.
  buildDemo() {
    const m = this.map, cities = [], units = [];
    let vis = null;
    if (m) {
      const good = { grass: 1.2, plains: 1.1, forest: .8, jungle: .5, hills: .9, beach: .3, tundra: .2 };
      const scored = [];
      for (const t of m.tiles) {
        if (!(t.height > 0) || !good[t.biome]) continue;
        let s = good[t.biome] + (t.river ? 2 : 0) + (t.resource ? .6 : 0);
        for (const n of neighbors(t.q, t.r)) { const o = m.get(n.q, n.r); if (o && o.biome === 'coast') { s += 1.4; break; } }
        scored.push([s, t]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      for (const [, t] of scored) {
        if (cities.length >= 7) break;
        if (cities.every(c => hexDistance(c.q, c.r, t.q, t.r) > 6)) cities.push({ q: t.q, r: t.r, civ: cities.length < 4 ? 0 : 1, capital: !cities.length });
      }
      for (const c of cities) for (const n of neighbors(c.q, c.r)) {
        const o = m.get(n.q, n.r);
        if (o && o.height > 0) { units.push({ q: o.q, r: o.r, civ: c.civ }); break; }
      }
      const mine = [...cities.filter(c => c.civ === 0), ...units.filter(u => u.civ === 0)];
      vis = new Uint8Array(m.tiles.length);
      for (const t of m.tiles) {
        let d = 99; for (const s of mine) d = Math.min(d, hexDistance(s.q, s.r, t.q, t.r));
        vis[t.i] = d <= 4 ? 2 : d <= 11 ? 1 : 0;
      }
    }
    return {
      turn: 78, year: -925, era: 'Classical', science: 412, culture: 208, faith: 134, gold: 318,
      inc: [0, 14, 12, 18, 9], cities, units, vis,
      colors: ['#4fa8ff', '#e0524a', '#f2c14a', '#7ad6a0'],
      sel: { kind: 'unit', name: 'Hoplite Vanguard', line: 'Aeonian · Melee Infantry', lvl: 2, hp: 82, hpMax: 100, stats: [['2/2', 'MOV'], ['24', 'STR'], ['1', 'RNG'], ['14/30', 'XP']] },
      log: [
        { msg: 'Celestial navigation is understood; harbours may be built.' },
        { msg: 'Thermai grows to seven citizens.' },
        { msg: 'The borders of Kadesh claim the marble ridge.' },
        { msg: 'A trade caravan waits for orders in Thermai.' },
      ],
    };
  }

  // ---------------------------------------------------------------- read state
  read(state) {
    const s = this.opts.game?.state ?? state ?? {};
    const civ = s.player ?? s.civs?.[0] ?? null;
    const d = this.demo;
    const R = s.rules ?? null;
    // income = [food, prod, gold, science, culture]; zeroed and refilled during endTurn, so on
    // turn 1 it is empty. Project from the cities that exist rather than showing a dead bar.
    const own = (s.cities ?? []).filter(c => c.civ === 0 && !c.dead);
    const inc = civ?.income?.some(Boolean) ? civ.income
      : civ ? [0, 0, 0, 0, 0].map((_, i) => Math.max(i > 1 ? 1 : 0, Math.round(own.reduce((a, c) => a + (c.yields?.[i] ?? 0), 0) || own.length * [0, 1.5, 1.2, 1.8, .9][i])))
      : d.inc;
    const techs = civ?.techs ?? DEMO_DONE;
    const researching = civ?.researching ?? DEMO_NOW;
    const cost = (R?.TECHS ?? TECHDATA)[researching];
    const rcost = (cost?.cost ?? cost?.[1]) || 1;
    const stock = civ?.science ?? d.science;
    const prog = civ ? (civ.progress ?? 0) : rcost * .62;
    const rate = Math.max(1, inc[3] || 1);

    const sel = this.selection(s, R, civ);
    const cities = (s.cities ?? d.cities).filter(c => !c.dead);
    const units = (s.units ?? d.units).filter(u => !u.dead);
    const colors = s.civs ? s.civs.map(c => hex6(c.color)) : d.colors;

    return {
      turn: s.turn ?? d.turn,
      year: s.year ?? d.year,
      civ: civ?.name ?? 'Aeon',
      colour: colors[0] ?? '#4fa8ff',
      era: s.eraName ?? (typeof s.era === 'number' ? ERA_NAMES[s.era] : s.era) ?? d.era,
      science: stock, culture: civ?.culture ?? d.culture, gold: civ?.gold ?? d.gold,
      // The rules module has no faith yet; scale a plausible devotion off the turn so the pillar
      // is neither a lie about a mid-game empire nor a dead zero.
      faith: civ?.faith ?? (civ ? Math.round((s.turn ?? 1) * 1.7) : d.faith),
      dScience: inc[3], dCulture: inc[4], dFaith: civ ? Math.max(1, Math.round(inc[4] * .6)) : 6, dGold: inc[2],
      rate,
      research: { name: title(researching), pct: Math.min(100, Math.round(100 * prog / rcost)), eta: Math.max(1, Math.ceil((rcost - prog) / rate)) },
      sel, cities, units, colors, techs, researching,
      vis: s.visibility ?? d.vis,
      rivals: (s.civs ?? DEMO_CIVS).slice(1).filter(c => c.alive !== false).map(c => ({
        i: c.i, name: c.name, adj: c.adj, color: c.color != null ? hex6(c.color) : c.hex,
        war: civ?.atWar?.has?.(c.i) ?? (Array.isArray(civ?.atWar) && civ.atWar.includes(c.i)),
      })),
      log: (s.log?.length ? s.log : d.log).slice(0, 4),
    };
  }

  // Prefer whatever the player clicked; fall back to their first live unit so the panel is
  // never an empty box (a 4X selects your first unit at turn start anyway).
  selection(s, R, civ) {
    const c = s.selected?.city ?? null;
    const u = s.selectedUnit ?? s.selected?.unit ?? (c ? null : s.units?.find(x => x.civ === 0 && !x.dead));
    if (c) {
      const y = c.yields ?? [0, 0, 0, 0, 0];
      return {
        kind: 'city', art: 'city', name: c.name, lvl: c.pop,
        line: `${s.civs?.[c.civ]?.adj ?? 'Free'} · ${c.capital ? 'Capital' : 'City'}`,
        hp: Math.round(c.hp), hpMax: c.maxHp || 100,
        stats: [[String(c.pop), 'POP'], [String(Math.round(y[0])), 'FOOD'], [String(Math.round(y[1])), 'PROD'], [String(Math.round(y[3])), 'SCI']],
      };
    }
    if (u) {
      const def = R?.UNITS?.[u.type] ?? {};
      return {
        kind: 'unit', art: def.civilian ? 'civil' : 'unit', name: u.name ?? title(u.type), lvl: (u.promo ?? 0) + 1,
        // Orders the unit cannot give are greyed, not hidden: the bar is a fixed five-column grid
        // and a warrior that is offered FOUND is the panel lying about the rules.
        off: def.civilian ? ['attack'] : ['found'],
        line: `${s.civs?.[u.civ]?.adj ?? 'Aeonian'} · ${def.civilian ? 'Civilian' : def.range ? 'Ranged' : 'Melee'}${u.fortified ? ' · Fortified' : ''}`,
        hp: Math.round(u.hp ?? 100), hpMax: 100,
        stats: [[`${u.mp ?? 0}/${u.maxMp ?? 2}`, 'MOV'], [String(def.str ?? 0), 'STR'], [String(def.range ?? 1), 'RNG'], [`${u.xp ?? 0}/10`, 'XP']],
      };
    }
    return { ...this.demo.sel, art: 'unit' };
  }

  // -------------------------------------------------------------- build
  mount() {
    if (this.root) return this;
    const root = this.root = el('div'); root.id = 'hud';
    const res = ['science', 'culture', 'faith', 'gold'];
    const resTip = {
      science: ['Science', 'Research output per turn. Spent on the technology tree.'],
      culture: ['Culture', 'Civic progress. Pays for the borders your cities claim.'],
      faith: ['Faith', 'Accumulated devotion. Buys holy sites and their orders.'],
      gold: ['Treasury', 'Gold on hand. A negative balance starts disbanding units.'],
    };
    root.innerHTML = `
      <div class="scrim t"></div><div class="scrim b"></div>

      <div class="top">
        <div class="grp l">
          <div class="crest" ${tip('Your civilisation', 'Empire summary: cities, treasury and the standing of your rivals.')}>${ICON.crest}<b data-f="civname">Aeon</b></div>
          <div class="res-strip">
            ${res.map(k => `
            <div class="res" data-k="${k}" ${tip(...resTip[k])}>
              <span class="ic">${ICON[k]}</span>
              <span class="stack"><span class="v num" data-f="${k}">0</span><span class="d up num" data-f="d${k}">+0</span></span>
            </div>`).join('')}
          </div>
        </div>
        <div class="grp r">
          <div class="diplo" data-f="diplo"></div>
          <button class="research" ${tip('Current research', 'Open the technology tree to change what you are researching.', 'T')}>
            <span class="ic">${ICON.science}</span>
            <span class="body">
              <span class="nm" data-f="rname">&mdash;</span>
              <span class="bar"><i data-f="rbar" style="width:0%"></i></span>
            </span>
            <span class="eta num" data-f="reta">&mdash;</span>
          </button>
          <button class="techbtn" ${tip('Technology tree', 'Browse the research graph and pick the next technology.', 'T')}>${ICON.tech}<span class="lbl">Tech</span><kbd>T</kbd></button>
        </div>
      </div>

      <div class="epoch" ${tip('Era and turn', 'The year advances forty winters a turn. Eras change as your civilisation researches into them.')}>
        <span class="wing l">${ICON.laurel}</span>
        <span class="txt">
          <span class="era lbl" data-f="era">&mdash;</span>
          <b class="turn num" data-f="turn">&mdash;</b>
          <span class="year num" data-f="year">&mdash;</span>
        </span>
        <span class="wing r">${ICON.laurel}</span>
      </div>

      <div class="sel pl">
        <div class="hdr"><span class="lbl kind" data-f="selkind">Unit</span>
          <span class="help" ${tip('Orders', 'Click an order, then click the map. Hold shift while clicking to queue several orders for this turn.')}>?</span></div>
        <div class="body">
          <div class="port"><span class="art" data-f="portrait">${PORTRAIT.unit}</span><span class="lvl num" data-f="lvl">1</span></div>
          <div class="info">
            <div class="nm" data-f="selname">&mdash;</div>
            <div class="sub" data-f="selline">&mdash;</div>
            <div class="hp"><span class="lbl">HP</span><span class="track"><i data-f="hpbar" style="width:100%"></i></span><span class="val num" data-f="hpval">&mdash;</span></div>
            <div class="stats" data-f="stats"></div>
          </div>
        </div>
        <div class="acts" data-f="acts"></div>
      </div>

      <div class="notes" data-f="notes"></div>

      <div class="console pl">
        <div class="well">
          <button class="endturn" ${tip('End turn', 'Hand play to the other civilisations. Nothing is waiting on you.', 'RETURN')}>
            <span class="sweep"></span><b>End Turn</b><i class="lbl" data-f="etsub">Ready</i>
          </button>
        </div>
        <div class="mini">
          <div class="mhdr"><span class="lbl">World Map</span><span class="rose">${ICON.compass}</span></div>
          <div class="wrap">
            <div class="screen"><canvas></canvas></div>
            <div class="rail">
              <button data-z="1" ${tip('Zoom in', 'Bring the camera toward the surface.')}>${ICON.plus}</button>
              <span class="sep"></span>
              <button data-z="-1" ${tip('Zoom out', 'Pull back for the strategic view.')}>${ICON.minus}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="tech">
        <div class="sheet pl">
          <div class="thdr">
            <h2>Technology</h2><span class="rule"></span>
            <span class="chips" data-f="chips"></span>
            <span class="lbl">Researching &middot; <span data-f="tname2">&mdash;</span></span>
            <button class="close" ${tip('Close', 'Return to the map.', 'ESC')}>${ICON.close}</button>
          </div>
          <div class="scrollwrap">
            <button class="page l" ${tip('Earlier eras', 'Scroll the tree back one era.')}>${ICON.chev}</button>
            <div class="scroll"><div class="graph"></div></div>
            <button class="page r" ${tip('Later eras', 'Scroll the tree on one era.')}>${ICON.chev}</button>
          </div>
          <div class="detail">
            <span class="di">${ICON.science}</span>
            <span class="dt"><b data-f="dname">&mdash;</b><span data-f="dblurb">Hover a technology to read what it unlocks.</span></span>
            <span class="dunl" data-f="dunl"></span>
            <span class="dc"><b class="num" data-f="dcost">&mdash;</b><span class="lbl">Science cost</span><span class="rate num" data-f="drate">&mdash;</span></span>
          </div>
        </div>
      </div>

      <div class="tip pl"><div class="tt"></div><div class="tb"></div><div class="tk"></div></div>`;
    document.body.appendChild(root);

    this.q = f => root.querySelector(`[data-f="${f}"]`);
    this.canvas = root.querySelector('.mini canvas');
    this.techEl = root.querySelector('.tech');
    this.tipEl = root.querySelector('.tip');
    this.initMini();
    this.wire();
    this.update();
    return this;
  }

  wire() {
    const r = this.root, tipEl = this.tipEl;
    r.addEventListener('mouseover', e => {
      const t = e.target.closest('[data-tip]'); if (!t) return;
      const [a, b = '', k = ''] = t.dataset.tip.split('|');
      tipEl.children[0].textContent = a; tipEl.children[1].textContent = b;
      tipEl.children[2].textContent = k; tipEl.children[2].style.display = k ? '' : 'none';
      tipEl.classList.add('show');
      const box = t.getBoundingClientRect();
      // Anchor to the panel the control lives in, not the control: a tip that opens over the
      // very panel you are reading is worse than no tip.
      const host = t.closest('.pl')?.getBoundingClientRect() ?? box;
      tipEl.style.left = Math.max(8, Math.min(innerWidth - 282, box.left + box.width / 2 - 132)) + 'px';
      tipEl.style.top = (box.top < 150 ? host.bottom + 10 : host.top - tipEl.offsetHeight - 10) + 'px';
    });
    r.addEventListener('mouseout', e => { if (!e.relatedTarget?.closest?.('[data-tip]')) tipEl.classList.remove('show'); });

    r.querySelector('.techbtn').onclick = r.querySelector('.research').onclick = () => this.toggleTech();
    r.querySelector('.tech .close').onclick = () => this.toggleTech(false);
    this.techEl.onclick = e => { if (e.target === this.techEl) this.toggleTech(false); };
    r.querySelector('.endturn').onclick = e => this.endTurn(e.currentTarget);
    // `input.zoom` is the rig's zoom SCALAR, not a method — calling it threw. The rail talks to
    // the camera the same way every other cross-module button does: one event, main.js listens.
    for (const b of r.querySelectorAll('.rail button'))
      b.onclick = () => dispatchEvent(new CustomEvent('aeon:zoom', { detail: +b.dataset.z }));
    const sc = r.querySelector('.tech .scroll');
    r.querySelector('.page.l').onclick = () => this.page(-1);
    r.querySelector('.page.r').onclick = () => this.page(1);
    sc.addEventListener('scroll', () => this.pageState(), { passive: true });
    r.querySelector('.acts').onclick = e => {
      const b = e.target.closest('.act'); if (!b || b.disabled) return;
      for (const o of r.querySelectorAll('.act')) o.classList.remove('on');
      b.classList.add('on');
      this.act(b.dataset.a);
    };
    addEventListener('keydown', e => {
      if (e.target.matches?.('input,textarea')) return;
      if (e.key === 't' || e.key === 'T') this.toggleTech();
      else if (e.key === 'Escape' && this.techEl.classList.contains('open')) { this.toggleTech(false); e.preventDefault(); }
      else if (e.key === 'Enter') r.querySelector('.endturn').click();
    });
    if (location.hash.includes('tech')) this.toggleTech(true);   // screenshot hook
  }

  act(key) {
    const g = this.opts.game;
    if (key === 'fortify') g?.fortify?.();
    else if (key === 'found') g?.foundHere?.();
    else if (key === 'buy') { const c = g?.state?.selected?.city; if (c) g.buyProduction(c); }
    // move / attack / produce / manage are click-modes owned by input.js; the pressed state is
    // the whole feedback here.
    dispatchEvent(new CustomEvent('aeon:action', { detail: key }));
  }

  toggleTech(on) {
    const open = on ?? !this.techEl.classList.contains('open');
    this.techEl.classList.toggle('open', open);
    this.tipEl.classList.remove('show');
    if (open) this.buildTree();
  }

  endTurn(btn) {
    btn.classList.add('busy');
    this.q('etsub').textContent = 'Processing';
    if (this.opts.game?.endTurn) this.opts.game.endTurn();
    else { this.demo.turn++; this.demo.year += 25; this.demo.gold += this.demo.inc[2]; this.demo.science += this.demo.inc[3]; }
    setTimeout(() => { btn.classList.remove('busy'); this.q('etsub').textContent = 'Ready'; }, 520);
  }

  // -------------------------------------------------------------- tech tree
  // Layered DAG: column = longest prerequisite chain (so every wire points forward), row =
  // barycentre of the parents' rows, each column centred vertically. Era bands are painted from
  // the columns those eras actually occupy, monotone so they never interleave.
  techModel(v) {
    const R = this.opts.game?.state?.rules ?? null;
    const src = R?.TECHS ?? TECHDATA;
    const ids = Object.keys(src);
    const N = new Map();
    for (const id of ids) {
      const g = src[id], d = TECHDATA[id] ?? [0, 100, 'A step along the road.', 'scroll'];
      const pre = (Array.isArray(g?.pre) ? g.pre : d.slice(4)).filter(p => src[p]);
      N.set(id, { id, name: title(id), era: g?.era ?? d[0], cost: g?.cost ?? d[1], blurb: d[2], ic: ICON[d[3]] ? d[3] : 'scroll', pre, unlocks: R?.TECH_UNLOCKS?.[id] ?? null });
    }
    const depth = id => { const n = N.get(id); if (n.d !== undefined) return n.d; n.d = 0; n.d = n.pre.length ? Math.max(...n.pre.map(depth)) + 1 : 0; return n.d; };
    const cols = [];
    for (const id of ids) (cols[depth(id)] ??= []).push(N.get(id));
    const rows = Math.max(...cols.map(c => c.length));
    const bary = n => (n.pre.length ? n.pre.reduce((a, p) => a + N.get(p).row, 0) / n.pre.length : rows / 2);
    cols.forEach((col, i) => {
      col.forEach(n => { n.col = i; n.row = 0; });
      col.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name));
      const off = (rows - col.length) / 2;
      col.forEach((n, j) => { n.row = off + j; });
    });
    const bands = []; let run = 0;
    cols.forEach((col, i) => {
      run = Math.max(run, Math.min(...col.map(n => n.era)));
      const last = bands[bands.length - 1];
      if (last && last.era === run) last.c1 = i; else bands.push({ era: run, c0: i, c1: i });
    });
    const has = t => (v.techs?.has ? v.techs.has(t) : DEMO_DONE.has(t));
    // Exactly four states, because four is what a player can learn to read at a glance:
    // researched, researching now, available to pick, and locked behind something else.
    // 'open' means every prerequisite is either already yours or on the bench right now: that is
    // the research front, and it is the only reading under which a turn-1 tree is not 30 locked
    // grey cards with nothing to look at.
    const ready = t => has(t) || t === v.researching;
    for (const n of N.values()) n.state = has(n.id) ? 'done' : n.id === v.researching ? 'now' : n.pre.every(ready) ? 'open' : 'lock';
    return { N, cols, rows, bands };
  }

  buildTree() {
    const v = this.read(), m = this.techModel(v);
    this.cache.__v = v;
    const graph = this.root.querySelector('.graph');
    const view = this.root.querySelector('.tech .scroll');
    graph.innerHTML = '';
    // Row pitch is fitted to the sheet so the graph fills its canvas instead of leaving the
    // bottom third empty and then clipping a card at the right-hand edge.
    const NW = 202, NH = 74, CW = NW + 38, PX = 34;
    const avail = Math.max(320, view.clientHeight || 470);
    // 62px of headroom is reserved for the era caption so a first-row card can never sit on it.
    const RW = Math.max(NH + 8, Math.min(108, (avail - 76) / m.rows));
    const PY = Math.max(62, (avail - 20 - m.rows * RW + (RW - NH)) / 2);
    const Wd = PX * 2 + m.cols.length * CW, Hd = Math.max(avail - 8, PY + m.rows * RW + 14);
    graph.style.width = Wd + 'px'; graph.style.height = Hd + 'px';
    const at = n => ({ x: PX + n.col * CW, y: PY + n.row * RW });
    this.colX = m.bands.map(b => Math.max(0, PX + b.c0 * CW - 28));

    for (const b of m.bands) {
      const count = m.cols.slice(b.c0, b.c1 + 1).reduce((a, c) => a + c.length, 0);
      const e = el('div', 'eracol' + (b.era % 2 ? ' alt' : ''),
        `<b>${ERA_NAMES[b.era] ?? 'Era ' + b.era}</b><i class="lbl">${ERA_YEARS[b.era] ?? ''} &middot; ${count} technologies</i>`);
      e.style.left = PX + b.c0 * CW - 22 + 'px';
      e.style.width = (b.c1 - b.c0 + 1) * CW + 'px';
      graph.appendChild(e);
    }

    // Orthogonal wiring: out of the right edge, along a lane between the columns, into the left
    // edge, with 8px corners and an arrow at the head. A bezier thicket cannot be traced; this
    // can, and hovering a node lights the whole chain that leads to it.
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(ns, 'svg');
    svgEl.setAttribute('width', Wd); svgEl.setAttribute('height', Hd);
    const lane = {}; this.wires = [];
    for (const n of [...m.N.values()].sort((a, b) => a.col - b.col || a.row - b.row)) {
      const b = at(n);
      for (const p of n.pre) {
        const pn = m.N.get(p), a = at(pn), done = pn.state === 'done';
        const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x - 9, y2 = b.y + NH / 2;
        const k = n.col; lane[k] = (lane[k] ?? 0) + 1;
        const mx = x1 + 14 + (lane[k] % 3) * 5, r = 8, s = y2 > y1 ? 1 : -1;
        const d = Math.abs(y2 - y1) < 2 ? `M${x1} ${y1}H${x2}`
          : `M${x1} ${y1}H${mx - r}Q${mx} ${y1} ${mx} ${y1 + s * r}V${y2 - s * r}Q${mx} ${y2} ${mx + r} ${y2}H${x2}`;
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'wire' + (done ? ' done' : n.state === 'lock' ? ' lock' : ''));
        const add = (t, a2) => { const e = document.createElementNS(ns, t); for (const kk in a2) e.setAttribute(kk, a2[kk]); g.appendChild(e); };
        add('path', { d, class: 'bg' });
        add('path', { d, class: 'fg' });
        add('path', { d: `M${x2 + 1} ${y2}l-8 -5v10z`, class: 'hd' });
        svgEl.appendChild(g);
        this.wires.push({ g, from: p, to: n.id });
      }
    }
    graph.appendChild(svgEl);

    this.tnodes = new Map();
    for (const n of m.N.values()) {
      const b = at(n);
      const turns = Math.max(1, Math.ceil(n.cost / v.rate));
      // Turn estimates are only shown for the research front, where the current rate is a real
      // forecast. Quoting "164 turns" against a fourth-era cost at a turn-1 rate is a lie.
      const meta = n.state === 'done' ? 'Researched'
        : n.state === 'now' ? `${v.research.pct}% complete &middot; ${v.research.eta} turns left`
        : n.state === 'open' ? `${n.cost} science &middot; ${turns} turns`
        : `${n.cost} science &middot; needs ${n.pre.filter(p => m.N.get(p).state !== 'done').map(p => m.N.get(p).name).join(', ')}`;
      const unl = (n.unlocks ?? []).slice(0, 3);
      const node = el('div', `tnode ${n.state}`,
        `<span class="ti">${ICON[n.ic]}</span>` +
        `<span class="tw"><span class="tn">${n.name}</span><span class="tm">${meta}</span>` +
        `<span class="tu">${unl.map(u => `<i class="u" ${tip(u.name, u.kind === 'unit' ? 'Unit unlocked by this technology.' : 'Building unlocked by this technology.')}>${ICON[UNLOCK_ICON[u.key]] ?? ICON.scroll}</i>`).join('')}</span></span>` +
        (n.state === 'done' ? `<span class="tick">${ICON.check}</span>` : '') +
        (n.state === 'lock' ? `<span class="pad">${ICON.lock}</span>` : '') +
        (n.state === 'now' ? `<span class="prog"><i style="width:${v.research.pct}%"></i></span>` : ''));
      node.style.left = b.x + 'px'; node.style.top = b.y + 'px';
      node.style.width = NW + 'px'; node.style.height = NH + 'px';
      node.onmouseenter = () => { this.showTech(n, m); this.litPath(n.id, m); };
      node.onclick = () => {
        if (n.state !== 'open') return;
        const g = this.opts.game;
        if (g?.setResearch && g.civs?.[0]) { g.setResearch(g.civs[0], n.id); this.buildTree(); }
      };
      graph.appendChild(node);
      this.tnodes.set(n.id, node);
    }
    this.q('chips').innerHTML = m.bands.map((b, i) =>
      `<button class="chip${ERA_NAMES[b.era] === v.era ? ' on' : ''}" data-i="${i}">${ERA_NAMES[b.era] ?? 'Era ' + b.era}</button>`).join('');
    this.q('chips').onclick = e => { const c = e.target.closest('.chip'); if (c) view.scrollTo({ left: this.colX[+c.dataset.i], behavior: 'smooth' }); };
    view.scrollLeft = 0;
    this.q('tname2').textContent = v.research.name;
    const cur = m.N.get(v.researching) ?? m.N.values().next().value;
    this.showTech(cur, m); this.litPath(cur.id, m);
    this.pageState();
  }

  // Gold along every prerequisite of the hovered node, 20% for everything else. Without this a
  // 32-node graph is a thicket; with it the question "what stands between me and gunpowder"
  // answers itself.
  litPath(id, m) {
    const set = new Set(), walk = x => { if (set.has(x)) return; set.add(x); for (const p of m.N.get(x)?.pre ?? []) walk(p); };
    walk(id);
    for (const w of this.wires) w.g.classList.toggle('lit', set.has(w.to) && set.has(w.from));
    for (const [k, e] of this.tnodes) e.classList.toggle('inpath', set.has(k));
  }

  // Paging moves era by era, and the scroll container snaps to those same boundaries, so a card
  // can never come to rest straddling the clip rect.
  page(dir) {
    const sc = this.root.querySelector('.tech .scroll'), xs = this.colX ?? [0];
    const cur = sc.scrollLeft;
    const next = dir > 0 ? xs.find(x => x > cur + 4) : [...xs].reverse().find(x => x < cur - 4);
    sc.scrollTo({ left: next ?? (dir > 0 ? sc.scrollWidth : 0), behavior: 'smooth' });
  }
  pageState() {
    const sc = this.root.querySelector('.tech .scroll'); if (!sc) return;
    const max = sc.scrollWidth - sc.clientWidth;
    this.root.querySelector('.page.l').disabled = sc.scrollLeft < 4;
    this.root.querySelector('.page.r').disabled = sc.scrollLeft > max - 4;
  }

  showTech(n, m) {
    if (!n) return;
    const d = this.root.querySelector('.tech .detail');
    d.querySelector('.di').innerHTML = ICON[n.ic];
    d.className = 'detail ' + n.state;
    this.q('dname').textContent = n.name;
    this.q('dblurb').textContent = n.blurb;
    const unl = n.unlocks ?? [];
    this.q('dunl').innerHTML = unl.length
      ? `<span class="lbl">Unlocks</span>` + unl.slice(0, 4).map(u =>
        `<span class="uc">${ICON[UNLOCK_ICON[u.key]] ?? ICON.scroll}<em>${u.name}</em></span>`).join('')
      : '';
    const v = this.cache.__v ?? { rate: 1 };
    const rate = Math.max(1, Math.round(v.rate));
    this.q('dcost').textContent = n.state === 'done' ? '—' : n.cost;
    // A turn estimate is only quoted where today's rate is a real forecast — the research front.
    // Dividing a fourth-era cost by a turn-one rate is arithmetically true and completely
    // useless: it says 176 turns for a technology your economy will reach in twenty. Anything
    // deeper in the tree is measured in prerequisites instead, which does not go stale.
    let line = 'Researched';
    if (n.state === 'now') line = `${Math.max(1, Math.ceil((n.cost * (1 - (v.research?.pct ?? 0) / 100)) / rate))} turns left at +${rate}/turn`;
    else if (n.state === 'open') line = `${Math.max(1, Math.ceil(n.cost / rate))} turns at +${rate}/turn`;
    else if (n.state === 'lock' && m) {
      const seen = new Set(), walk = x => { if (seen.has(x)) return; seen.add(x); for (const q of m.N.get(x)?.pre ?? []) walk(q); };
      walk(n.id);
      const left = [...seen].filter(x => m.N.get(x).state !== 'done').length;
      line = `${left} ${left === 1 ? 'technology' : 'technologies'} away`;
    }
    this.q('drate').textContent = line;
  }

  // -------------------------------------------------------------- minimap
  // Three layers, each rebuilt only when its own input changes. The tile plate is rasterised
  // once at 3x (2.8k hexes is far too much to repaint per frame on software GL, and the
  // downsample is what kills the stair-stepped coastline); the fog mask is repainted when
  // visibility changes, i.e. once a turn; the markers and the view box are the only per-move
  // work. A redraw is two blits plus a handful of glyphs.
  initMini() {
    const c = this.canvas, dpr = Math.min(devicePixelRatio, 2), W = 250, H = 168, SS = 3;
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = W + 'px'; c.style.height = H + 'px';
    this.ctx = c.getContext('2d'); this.ctx.scale(dpr, dpr);
    this.ctx.imageSmoothingQuality = 'high';
    this.mm = { W, H, S: 1, ox: 0, oy: 0, SS };
    const m = this.map; if (!m) return;
    // Hexes are drawn in (q,r) space. World->grid is a shear, so a flat-top hexagon becomes this
    // sheared hexagon — which still tiles the plane exactly: no seams, no gaps.
    this.HEX = [[.667, -.333], [.333, .333], [-.333, .667], [-.667, .333], [-.333, -.333], [.333, -.667]];
    const S = this.mm.S = Math.min(W / (m.w + .8), H / (m.h + .8));
    this.mm.ox = (W - m.w * S) / 2 + S / 2;
    this.mm.oy = (H - m.h * S) / 2 + S / 2;
    const base = this.base = document.createElement('canvas');
    base.width = W * SS; base.height = H * SS;
    const b = base.getContext('2d'); b.scale(SS, SS);
    b.fillStyle = '#091320'; b.fillRect(0, 0, W, H);
    for (const t of m.tiles) {
      let [r0, g0, b0] = MINI_BIOME[t.biome] ?? [255, 0, 255];
      let k = t.height > 0 ? .82 + .30 * (t.elev - m.seaLevel) / (1 - m.seaLevel) : .72 + .5 * (t.elev / m.seaLevel);
      // hillshade from the west neighbour: the same light direction the scene uses, so the
      // cordillera reads as a range on the minimap instead of a white smear
      if (t.height > 0) { const o = m.get(t.q - 1, t.r); if (o) k *= 1 + Math.max(-.34, Math.min(.4, (t.elev - o.elev) * 9)); }
      r0 = Math.min(255, r0 * k); g0 = Math.min(255, g0 * k); b0 = Math.min(255, b0 * k);
      if (t.river) { r0 = r0 * .45 + 56; g0 = g0 * .45 + 116; b0 = b0 * .45 + 150; }
      b.fillStyle = `rgb(${r0 | 0},${g0 | 0},${b0 | 0})`;
      this.hex(b, t.q, t.r, S);
    }
    // one dark ring on every coastal land tile: the silhouette reads at 4px per hex
    b.globalAlpha = .5; b.strokeStyle = '#06121c'; b.lineWidth = .8;
    for (const t of m.tiles) {
      if (!(t.height > 0)) continue;
      for (const n of neighbors(t.q, t.r)) {
        const o = m.get(n.q, n.r);
        if (o && !(o.height > 0)) { const [x, y] = this.qr(t.q, t.r); b.beginPath(); b.arc(x, y, S * .5, 0, 6.284); b.stroke(); break; }
      }
    }
    b.globalAlpha = 1;
    this.fog = document.createElement('canvas');
    this.fog.width = W * SS; this.fog.height = H * SS;
  }
  qr(q, r) { return [this.mm.ox + q * this.mm.S, this.mm.oy + r * this.mm.S]; }
  hex(g, q, r, S) {
    const [x, y] = this.qr(q, r);
    g.beginPath();
    for (let i = 0; i < 6; i++) { const px = x + this.HEX[i][0] * S, py = y + this.HEX[i][1] * S; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.closePath(); g.fill();
  }

  // Unexplored ground is flat dark parchment — a chart with nothing drawn on it yet, not the
  // terrain at 12% opacity, which is just a cheat. Ground you have seen but cannot see now keeps
  // its shape and loses its light. Turn 1 shows a lit island on an empty sheet, which is the
  // whole point of a strategy map.
  buildFog(vis) {
    const { W, H, S, SS } = this.mm, g = this.fog.getContext('2d');
    g.setTransform(SS, 0, 0, SS, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#2b2519';
    for (const t of this.map.tiles) {
      const v = vis ? vis[t.i] : 2;
      if (v === 2) continue;
      if (v) { g.fillStyle = 'rgba(26,28,31,.5)'; this.hex(g, t.q, t.r, S + .02); g.fillStyle = '#2b2519'; }
      else this.hex(g, t.q, t.r, S + .02);
    }
    // Parchment: mottled fibre and a few foxing blooms, painted only where the sheet is blank.
    g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * W, y = Math.random() * H, k = Math.random();
      g.globalAlpha = .05 + k * .1;
      g.fillStyle = k > .5 ? '#8b7c5c' : '#15110b';
      g.fillRect(x, y, .7 + k, .7 + k);
    }
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * W, y = Math.random() * H, r = 4 + Math.random() * 12;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(120,102,68,.16)'); gr.addColorStop(1, 'rgba(120,102,68,0)');
      g.globalAlpha = 1; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
    }
    // Chart furniture, drawn only where the sheet is still blank: a graticule and a compass rose
    // watermark. An unexplored quarter of the world should look like a map nobody has drawn on
    // yet, which is a surface with intent — not an empty rectangle.
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(148,128,90,.17)'; g.lineWidth = .5;
    for (let x = 12; x < W; x += 25) { g.beginPath(); g.moveTo(x + .25, 0); g.lineTo(x + .25, H); g.stroke(); }
    for (let y = 10; y < H; y += 25) { g.beginPath(); g.moveTo(0, y + .25); g.lineTo(W, y + .25); g.stroke(); }
    const cx = W * .17, cy = H * .74, R = Math.min(W, H) * .155;
    g.strokeStyle = 'rgba(178,154,106,.24)'; g.lineWidth = .8;
    g.beginPath(); g.arc(cx, cy, R, 0, 6.284); g.stroke();
    g.beginPath(); g.arc(cx, cy, R * .62, 0, 6.284); g.stroke();
    g.fillStyle = 'rgba(178,154,106,.2)';
    for (let k = 0; k < 8; k++) {
      const a2 = k * Math.PI / 4, r2 = k % 2 ? R * .62 : R, w2 = k % 2 ? R * .1 : R * .16;
      g.beginPath();
      g.moveTo(cx + Math.cos(a2) * r2, cy + Math.sin(a2) * r2);
      g.lineTo(cx + Math.cos(a2 + 1.5708) * w2, cy + Math.sin(a2 + 1.5708) * w2);
      g.lineTo(cx - Math.cos(a2) * w2 * .4, cy - Math.sin(a2) * w2 * .4);
      g.lineTo(cx + Math.cos(a2 - 1.5708) * w2, cy + Math.sin(a2 - 1.5708) * w2);
      g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  drawMini(v) {
    const g = this.ctx, { W, H } = this.mm; if (!g) return;
    g.clearRect(0, 0, W, H);
    if (this.base) g.drawImage(this.base, 0, 0, W, H); else { g.fillStyle = '#091320'; g.fillRect(0, 0, W, H); }
    if (this.fog) g.drawImage(this.fog, 0, 0, W, H);

    // camera view box: four corner rays against a mean ground plane, clamped so rays that clear
    // the horizon become a long trapezoid instead of shooting to infinity.
    if (this.camera?.matrixWorld) {
      const e = this.camera.matrixWorld.elements;
      const th = Math.tan(this.camera.fov * Math.PI / 360), tw = th * this.camera.aspect;
      const ox = e[12], oy = e[13], oz = e[14], GY = 1.6, pts = [], rays = [];
      for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
        const dx = e[0] * sx * tw + e[4] * sy * th - e[8], dy = e[1] * sx * tw + e[5] * sy * th - e[9], dz = e[2] * sx * tw + e[6] * sy * th - e[10];
        rays.push([dx, dy, dz, dy < -1e-4 ? (GY - oy) / dy : 1e5]);
      }
      // The bottom two corners always hit the ground; the top two may clear the horizon. Cap the
      // far edge at a fixed multiple of the near distance so the box stays a trapezoid that
      // scales with zoom instead of a spike shooting off the map.
      const far = 2.0 * Math.max(rays[2][3] * Math.hypot(rays[2][0], rays[2][2]), rays[3][3] * Math.hypot(rays[3][0], rays[3][2]));
      for (const [dx, dy, dz, t0] of rays) {
        const t = Math.min(t0, far / Math.hypot(dx, dz));
        const wx = ox + dx * t, wz = oz + dz * t, q = wx / 1.5;
        pts.push(this.qr(q, wz / Math.sqrt(3) - q / 2));
      }
      const m = this.map;
      g.save();
      // clipped to the board: a 16-degree camera really does see a long wedge, but it should end
      // at the edge of the world, not at the edge of the panel
      g.beginPath(); g.rect(this.mm.ox - this.mm.S / 2, this.mm.oy - this.mm.S / 2, m.w * this.mm.S, m.h * this.mm.S); g.clip();
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fillStyle = 'rgba(255,250,235,.07)'; g.fill();
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 3.2; g.stroke();
      // A soft glow rather than a hard white keyline: the view box has to be findable without
      // becoming the brightest thing on the screen.
      g.shadowColor = 'rgba(255,240,200,.6)'; g.shadowBlur = 4;
      g.strokeStyle = 'rgba(250,242,220,.5)'; g.lineWidth = 1.6; g.stroke();
      g.shadowBlur = 0;
      g.restore();
    }

    // Markers read by shape before colour: a star is your capital, a square a city, a dot a
    // unit. Nothing is drawn on ground the player has never seen.
    const seen = i => !v.vis || v.vis[i] !== 0;
    const idx = (q, r) => this.map?.get(q, r)?.i;
    const ring = (x, y, f) => { g.lineWidth = 1.6; g.strokeStyle = 'rgba(8,6,3,.9)'; g.stroke(); g.fillStyle = f; g.fill(); };
    for (const u of v.units) {
      const i = idx(u.q, u.r); if (i != null && !seen(i)) continue;
      const [x, y] = this.qr(u.q, u.r);
      g.beginPath(); g.arc(x, y, 2.5, 0, 6.284);
      ring(x, y, v.colors[u.civ] ?? '#efe0bb');
    }
    for (const c of v.cities) {
      const i = idx(c.q, c.r); if (i != null && !seen(i)) continue;
      const [x, y] = this.qr(c.q, c.r), f = v.colors[c.civ] ?? '#f6d281';
      g.beginPath();
      if (c.capital) {
        for (let k = 0; k < 10; k++) {
          const a = -Math.PI / 2 + k * Math.PI / 5, rr = k & 1 ? 2.4 : 5.4;
          const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
          k ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath();
      } else g.rect(x - 3.1, y - 3.1, 6.2, 6.2);
      ring(x, y, f);
    }
  }

  // -------------------------------------------------------------- per-frame
  set(f, val) { if (this.cache[f] === val) return; this.cache[f] = val; const e = this.q(f); if (e) e.textContent = val; }
  width(f, pct) { const k = f + '#'; if (this.cache[k] === pct) return; this.cache[k] = pct; const e = this.q(f); if (e) e.style.width = pct + '%'; }

  update(state) {
    if (!this.root) return;
    const v = this.read(state);
    this.cache.__v = v;
    if (this.cache.__civ !== v.colour) { this.cache.__civ = v.colour; this.root.style.setProperty('--civ', v.colour); }
    this.set('science', fmt(v.science)); this.set('culture', fmt(v.culture));
    this.set('faith', fmt(v.faith)); this.set('gold', fmt(v.gold));
    for (const [f, n] of [['dscience', v.dScience], ['dculture', v.dCulture], ['dfaith', v.dFaith], ['dgold', v.dGold]]) {
      this.set(f, sign(n));
      const e = this.q(f); if (e) { e.classList.toggle('up', n >= 0); e.classList.toggle('dn', n < 0); }
    }
    this.set('civname', v.civ);
    const dkk = v.rivals.map(r => r.name + r.war).join();
    if (this.cache.__dip !== dkk) {
      this.cache.__dip = dkk;
      this.q('diplo').innerHTML = v.rivals.map((r, i) =>
        `<button class="dip${r.war ? ' war' : ''}" style="--c:${r.color}" ${tip(r.name, r.war ? 'At war with you. No treaties stand.' : 'Known power. No hostilities declared.')}>${cameo(i, r.color)}</button>`).join('');
    }
    this.set('era', v.era + ' Era');
    this.set('turn', 'Turn ' + v.turn);
    this.set('year', yearTxt(v.year));
    this.set('rname', v.research.name);
    this.set('reta', v.research.eta + (v.research.eta === 1 ? ' turn' : ' turns'));
    this.width('rbar', v.research.pct);

    const s = v.sel;
    this.set('selkind', s.kind === 'city' ? 'City' : 'Unit');
    this.set('selname', s.name);
    this.set('selline', s.line);
    this.set('lvl', s.lvl);
    this.set('hpval', `${s.hp}/${s.hpMax}`);
    const pct = Math.round(100 * s.hp / (s.hpMax || 100));
    this.width('hpbar', pct);
    const band = pct > 60 ? 'ok' : pct > 30 ? 'warn' : 'bad';
    if (this.cache.__band !== band) { this.cache.__band = band; this.q('hpbar').className = band; }
    if (this.cache.__art !== s.art) { this.cache.__art = s.art; this.q('portrait').innerHTML = PORTRAIT[s.art] ?? PORTRAIT.unit; }
    const off = s.off ?? [];
    if (this.cache.__kind !== s.kind + off) {
      this.cache.__kind = s.kind + off;
      this.q('acts').innerHTML = ACTIONS[s.kind].map(([k, l, ic, t, b, h], i) =>
        `<button class="act${i ? '' : ' on'}${off.includes(k) ? ' off' : ''}" data-a="${k}" ${tip(t, b, h)}>${ICON[ic]}<em class="lbl">${l}</em></button>`).join('');
    }
    const st = s.stats.map(x => x.join('')).join('|');
    if (this.cache.__st !== st) {
      this.cache.__st = st;
      this.q('stats').innerHTML = s.stats.map(([val, k]) =>
        `<span class="st" ${tip(k, '')}>${ICON[STAT_ICON[k]] ?? ''}<b class="num">${val}</b><span class="lbl">${k}</span></span>`).join('');
    }

    const lk = v.log.map(l => l.msg).join('|');
    if (this.cache.__log !== lk) {
      this.cache.__log = lk;
      this.q('notes').innerHTML = v.log.map((l, i) => {
        const [t, ic] = noteKind(l.msg);
        return `<div class="note pl k-${ic}" style="animation-delay:${.08 + i * .09}s"><span class="ic">${ICON[ic]}</span><span class="tx"><span class="t lbl">${t}</span><span class="s">${l.msg}</span></span><span class="stamp num">T${l.turn ?? v.turn}</span></div>`;
      }).join('');
    }

    // Fog is a per-turn quantity; hashing it every frame would be worse than repainting it.
    let fk = v.turn;
    if (v.vis) for (let i = 0; i < v.vis.length; i += 37) fk = (fk * 31 + v.vis[i]) | 0;
    if (this.map && this.cache.__fog !== fk) {
      this.cache.__fog = fk;
      this.buildFog(v.vis); this.pose = '';
    }
    // Minimap: repaint only when the camera actually moved or a marker changed. The key is a
    // scalar hash of the camera basis, not a joined string — update() runs every frame.
    const e = this.camera?.matrixWorld?.elements;
    const key = (e ? Math.round((e[12] * 7 + e[13] * 13 + e[14] * 17 + e[0] * 991 + e[8] * 1553) * 8) : 0)
      + v.cities.length * 1e7 + v.units.length * 1e5 + v.turn;
    if (key !== this.pose) { this.pose = key; this.drawMini(v); }
  }

  dispose() { this.root?.remove(); this.root = null; }
}
