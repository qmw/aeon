// integrator: hue/sat/val + chroma-speckle audit. node tools/_ihue.mjs shot.png [x,y:name ...]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const pts = process.argv.slice(3).map(s => { const [c, n] = s.split(':'); const [x, y] = c.split(',').map(Number); return { x, y, n: n || `${x},${y}` }; });
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const out = await p.evaluate(async ({ url, pts }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const D = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
  const at = (x, y) => { const o = (y * W + x) * 4; return [D[o], D[o + 1], D[o + 2]]; };
  const hsv = ([r, g2, b2]) => { r /= 255; g2 /= 255; b2 /= 255; const mx = Math.max(r, g2, b2), mn = Math.min(r, g2, b2), d = mx - mn;
    let h = 0; if (d) h = mx === r ? 60 * (((g2 - b2) / d) % 6) : mx === g2 ? 60 * ((b2 - r) / d + 2) : 60 * ((r - g2) / d + 4);
    return [(h + 360) % 360, mx ? d / mx : 0, mx]; };
  // median 5x5 sample so a single confetti pixel does not decide the answer
  const med = (x, y) => { const R = [], G = [], B = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const q = at(x + dx, y + dy); R.push(q[0]); G.push(q[1]); B.push(q[2]); }
    const m = a => a.sort((u, v) => u - v)[12]; return [m(R), m(G), m(B)]; };
  const probes = pts.map(P => { const rgb = med(P.x, P.y), [h, s, v] = hsv(rgb);
    return { n: P.n, hex: '#' + rgb.map(z => z.toString(16).padStart(2, '0')).join(''), hue: +h.toFixed(1), sat: +s.toFixed(3), val: +v.toFixed(3) }; });
  // chroma-speckle: fraction of pixels whose OPPONENT channels differ from the 5x5 median by >22
  const speck = (x0, y0, w, h2) => { let n = 0, k = 0;
    for (let y = y0; y < y0 + h2; y++) for (let x = x0; x < x0 + w; x++) { if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
      const q = at(x, y), m = med(x, y);
      const dr = q[0] - m[0], dg = q[1] - m[1], db = q[2] - m[2];
      // opponent = chroma-only deviation (remove the common luma part)
      const l = (dr + dg + db) / 3;
      if (Math.max(Math.abs(dr - l), Math.abs(dg - l), Math.abs(db - l)) > 22) k++; n++; }
    return +(100 * k / n).toFixed(2); };
  return { probes, speckle: [[60, 90, 240, 160, 'far'], [700, 700, 240, 160, 'near'], [1150, 200, 200, 130, 'water'], [40, 700, 200, 120, 'ui-panel']]
    .map(([x, y, w, h2, n]) => ({ n, pct: speck(x, y, w, h2) })) };
}, { url: 'data:image/png;base64,' + readFileSync(file).toString('base64'), pts });
console.log(JSON.stringify(out));
await b.close();
