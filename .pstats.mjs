// image stats: node .pstats.mjs <png> [regions.json]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const file = process.argv[2];
const b64 = readFileSync(file).toString('base64');
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const out = await p.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  const D = x.getImageData(0, 0, cv.width, cv.height).data;
  const L = (i) => 0.2126*D[i] + 0.7152*D[i+1] + 0.0722*D[i+2];
  // world region: exclude HUD strips
  const inHud = (px, py) => py < 48 || (px > 1260 && py < 300) || (px < 400 && py > 670) || (px > 1280 && py > 580);
  const hist = new Float64Array(256); let n = 0, sumBR = 0;
  for (let y = 0; y < cv.height; y++) for (let px = 0; px < cv.width; px++) {
    if (inHud(px, y)) continue;
    const i = (y*cv.width+px)*4; hist[Math.round(L(i))]++; n++;
  }
  const pct = (q) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= q*n) return v; } return 255; };
  let above250 = 0; for (let v = 251; v < 256; v++) above250 += hist[v];
  // AA probe: count 1-px luma spikes along scanlines in the world
  let spikes = 0, edges = 0;
  for (let y = 100; y < 860; y += 7) for (let px = 420; px < 1250; px++) {
    const i = (y*cv.width+px)*4;
    const a = L(i-4), c = L(i), d = L(i+4);
    if (Math.abs(c-a) > 30 && Math.abs(c-d) > 30 && Math.sign(c-a) === Math.sign(c-d)) spikes++;
    if (Math.abs(d-a) > 45) edges++;
  }
  const box = (x0,y0,x1,y1) => { let s=0,k=0,r=0,g=0,bl=0; for (let y=y0;y<y1;y++) for (let px=x0;px<x1;px++){const i=(y*cv.width+px)*4; s+=L(i);r+=D[i];g+=D[i+1];bl+=D[i+2];k++;} return {L:+(s/k).toFixed(1), r:+(r/k).toFixed(1), g:+(g/k).toFixed(1), b:+(bl/k).toFixed(1), BR:+((bl-r)/k).toFixed(1)}; };
  return { median: pct(0.5), p05: pct(0.05), p95: pct(0.95), p99: pct(0.99),
    pctAbove250: +(100*above250/n).toFixed(3), spikes, edges,
    leftField: box(60,300,300,520), rightSand: box(1150,600,1380,780), ocean: box(1300,80,1500,200),
    lake: box(700,540,860,640) };
}, b64);
console.log(JSON.stringify(out, null, 1));
await b.close();
