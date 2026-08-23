// units agent: dominant colours in a small box. node tools/_upix.mjs img.png x y w h
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , f, X, Y, W, H] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const out = await p.evaluate(async ({ url, X, Y, W, H }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(X, Y, W, H).data;
  let n = 0, hueBlue = 0, satS = 0, lumS = 0, chromaHi = 0;
  const hist = {};
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], bb = d[i + 2];
    const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb);
    const s = mx ? (mx - mn) / mx : 0;
    let h = 0;
    if (mx !== mn) {
      if (mx === r) h = 60 * (((gg - bb) / (mx - mn)) % 6);
      else if (mx === gg) h = 60 * ((bb - r) / (mx - mn) + 2);
      else h = 60 * ((r - gg) / (mx - mn) + 4);
    }
    if (h < 0) h += 360;
    satS += s; lumS += 0.2126 * r + 0.7152 * gg + 0.0722 * bb; n++;
    if (s >= 0.30 && h > 175 && h < 265) hueBlue++;
    if (s >= 0.45) chromaHi++;
    const key = Math.round(h / 30) * 30; hist[key] = (hist[key] || 0) + 1;
  }
  return { n, sat: +(satS / n).toFixed(3), lum: +(lumS / n).toFixed(1),
    bluePct: +(100 * hueBlue / n).toFixed(1), chromaHiPct: +(100 * chromaHi / n).toFixed(1),
    hues: Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + 'deg:' + (100 * v / n).toFixed(0) + '%') };
}, { url: 'data:image/png;base64,' + readFileSync(f).toString('base64'), X: +X, Y: +Y, W: +W, H: +H });
console.log(JSON.stringify(out));
await b.close();
