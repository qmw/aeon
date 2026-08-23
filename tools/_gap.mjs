// aerial-perspective probe: mean L, saturation and B-R for a set of points, 9x9 averaged.
// node tools/_gap.mjs shot.png x,y:name ...
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const pts = process.argv.slice(3).map(s => { const [c, n] = s.split(':'); const [x, y] = c.split(',').map(Number); return { x, y, name: n }; });
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
console.log(JSON.stringify(await p.evaluate(async ({ url, pts }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  return pts.map(P => { let r = 0, gg = 0, bl = 0, n = 0;
    for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) { const o = ((P.y + j) * c.width + (P.x + i)) * 4; r += d[o]; gg += d[o + 1]; bl += d[o + 2]; n++; }
    r /= n; gg /= n; bl /= n;
    const mx = Math.max(r, gg, bl), mn = Math.min(r, gg, bl);
    const L = 0.2126 * r + 0.7152 * gg + 0.0722 * bl;
    let h = 0; const c2 = mx - mn;
    if (c2 > 0) { h = mx === r ? ((gg - bl) / c2 + 6) % 6 : mx === gg ? (bl - r) / c2 + 2 : (r - gg) / c2 + 4; h *= 60; }
    return { name: P.name, L: +L.toFixed(1), sat: +(c2 / Math.max(mx, 1)).toFixed(3), BminusR: +(bl - r).toFixed(0), hue: +h.toFixed(0), rgb: [r, gg, bl].map(v => Math.round(v)) };
  });
}, { url: 'data:image/png;base64,' + readFileSync(process.argv[2] ?? '').toString('base64'), pts }), null, 0));
await b.close();
