// is grid.js's decal protect mask actually reaching post.js? histogram the graded frame's alpha.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(n => (window.__frameCount || 0) >= n, +(process.env.F || 6), { timeout: 300000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const r = window.renderer, t = window.post._gradeRT;
  const w = t.width, h = t.height, buf = new Uint8Array(w * h * 4);
  r.readRenderTargetPixels(t, 0, 0, w, h, buf);
  const hist = new Array(9).fill(0);
  for (let i = 3; i < buf.length; i += 4) hist[Math.min(8, buf[i] >> 5)]++;
  return { size: [w, h], alphaHist32: hist, pctUnder224: +(100 * hist.slice(0, 7).reduce((a, b) => a + b, 0) / (w * h)).toFixed(2) };
})));
await b.close();
