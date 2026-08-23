// terrain stats: node tools/_t3.mjs img.png x,y,w,h [more boxes...]
// per box: mean RGB, hue(deg) mean/std, sat, luma mean/std, lowfreq(>6px) std, ratio
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , inp, ...boxes] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage();
const out = await p.evaluate(async ({ b64, boxes }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const res = [];
  for (const bs of boxes) {
    const [x0, y0, w, h] = bs.split(',').map(Number);
    const lum = new Float64Array(w * h);
    let R = 0, G = 0, B = 0, S = 0, hx = 0, hy = 0, n = 0;
    const hues = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * W + x0 + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      R += r; G += gg; B += b; n++;
      lum[y * w + x] = 0.299 * r + 0.587 * gg + 0.114 * b;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dl = mx - mn;
      S += mx ? dl / mx : 0;
      let hu = 0;
      if (dl > 0) { hu = mx === r ? ((gg - b) / dl % 6) : mx === gg ? ((b - r) / dl + 2) : ((r - gg) / dl + 4); hu *= 60; if (hu < 0) hu += 360; }
      hues.push(hu); hx += Math.cos(hu * Math.PI / 180); hy += Math.sin(hu * Math.PI / 180);
    }
    // box blur radius 6 -> low frequency
    const lo = new Float64Array(w * h); const rad = 6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, m = 0;
      for (let j = -rad; j <= rad; j += 2) for (let i = -rad; i <= rad; i += 2) {
        const yy = Math.min(h - 1, Math.max(0, y + j)), xx = Math.min(w - 1, Math.max(0, x + i));
        s += lum[yy * w + xx]; m++;
      }
      lo[y * w + x] = s / m;
    }
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const std = (a, mu) => Math.sqrt(a.reduce((s, v) => s + (v - mu) * (v - mu), 0) / a.length);
    const lm = mean(Array.from(lum)), ls = std(Array.from(lum), lm);
    const om = mean(Array.from(lo)), os = std(Array.from(lo), om);
    const hmean = (Math.atan2(hy, hx) * 180 / Math.PI + 360) % 360;
    const hstd = Math.sqrt(hues.reduce((s, hu) => { let dd = ((hu - hmean + 540) % 360) - 180; return s + dd * dd; }, 0) / hues.length);
    res.push({ box: bs, rgb: [R / n | 0, G / n | 0, B / n | 0], sat: +(S / n).toFixed(3), hue: +hmean.toFixed(1), hueStd: +hstd.toFixed(1), lum: +lm.toFixed(1), std: +ls.toFixed(1), lowStd: +os.toFixed(1), ratio: +(os / ls).toFixed(2) });
  }
  return res;
}, { b64, boxes });
console.log(out.map(o => JSON.stringify(o)).join('\n'));
await br.close();
