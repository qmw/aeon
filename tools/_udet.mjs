// units agent: A/B the detail shader on buildings. node tools/_udet.mjs out.png [uDetail]
import { chromium } from 'playwright';
const [, , out = '/tmp/d.png', det = '1'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 6, null, { timeout: 240000 }).catch(() => {});
await p.evaluate(v => { window.units.u.uDetail.value = v; setInterval(() => { window.units.u.uDetail.value = v; }, 50); }, +det);
const f0 = await p.evaluate(() => window.__frameCount || 0);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, f0 + 22, { timeout: 300000 }).catch(() => {});
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, det, errs: errs.slice(0, 3) }));
await b.close();
