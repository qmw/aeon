// scratch: image stats. node tools/_pstat.mjs in.png [mode] [args...]
//  scan  in.png y x0 x1        -> per-pixel RGB along a scanline
//  band  in.png                -> global clip/saturation/depth-band stats
//  box   in.png x y w h        -> gradient energy, speck rate, lum stats
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , inp, mode = 'band', ...rest] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage();
const out = await p.evaluate(async ({ b64, mode, rest }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const L = (i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const sat = (i) => { const r = d[i*4], gg = d[i*4+1], b = d[i*4+2]; const mx = Math.max(r,gg,b), mn = Math.min(r,gg,b); return mx ? (mx-mn)/mx : 0; };
  const A = rest.map(Number);
  if (mode === 'scan') {
    const [y, x0, x1] = A; const o = [];
    for (let x = x0; x <= x1; x++) { const i = y * W + x; o.push(`${x}:${d[i*4]},${d[i*4+1]},${d[i*4+2]}|L${L(i).toFixed(0)}`); }
    return o.join(' ');
  }
  if (mode === 'box') {
    const [x0, y0, w, h] = A;
    let e = 0, n = 0, m = 0, m2 = 0, speck = 0, sp = 0;
    for (let y = y0 + 1; y < y0 + h - 1; y++) for (let x = x0 + 1; x < x0 + w - 1; x++) {
      const i = y * W + x;
      for (let ch = 0; ch < 3; ch++) e += Math.abs(d[i*4+ch] - d[(i+1)*4+ch]) + Math.abs(d[i*4+ch] - d[(i+W)*4+ch]);
      n += 6;
      const l = L(i); m += l; m2 += l * l; sp++;
      const nb = (L(i-1) + L(i+1) + L(i-W) + L(i+W)) / 4;
      if (Math.abs(l - nb) > 45) speck++;
    }
    m /= sp;
    let sa = 0; for (let y = y0; y < y0+h; y++) for (let x = x0; x < x0+w; x++) sa += sat(y*W+x);
    return JSON.stringify({ grad: +(e/n*3).toFixed(2), lum: +m.toFixed(1), std: +Math.sqrt(m2/sp - m*m).toFixed(1), sat: +(sa/(w*h)).toFixed(3), speckPct: +(speck/sp*100).toFixed(3) });
  }
  // band
  const hist = new Array(256).fill(0);
  let rc = 0, gc = 0, bc = 0, N = 0, ms = 0;
  const bands = [[60,240],[300,480],[600,780]].map(() => ({ s: 0, l: 0, n: 0 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x > 1270 || (y < 46) || (y > 670 && x < 400) || (y > 570 && x > 1290)) continue; // skip UI
    const i = y * W + x;
    hist[Math.round(L(i))]++; N++;
    if (d[i*4] >= 254) rc++; if (d[i*4+1] >= 254) gc++; if (d[i*4+2] >= 254) bc++;
    ms += sat(i);
    const bi = y < 240 ? 0 : (y >= 300 && y < 480 ? 1 : (y >= 600 && y < 780 ? 2 : -1));
    if (bi >= 0 && y >= 60) { bands[bi].s += sat(i); bands[bi].l += L(i); bands[bi].n++; }
  }
  const pct = (q) => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= N*q) return v; } return 255; };
  return JSON.stringify({
    p1: pct(0.01), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
    meanSat: +(ms/N).toFixed(3),
    clipR: +(rc/N*100).toFixed(3), clipG: +(gc/N*100).toFixed(3), clipB: +(bc/N*100).toFixed(3),
    satFar: +(bands[0].s/bands[0].n).toFixed(3), satMid: +(bands[1].s/bands[1].n).toFixed(3), satNear: +(bands[2].s/bands[2].n).toFixed(3),
    lumFar: +(bands[0].l/bands[0].n).toFixed(1), lumNear: +(bands[2].l/bands[2].n).toFixed(1),
  });
}, { b64, mode, rest });
console.log(out);
await br.close();
