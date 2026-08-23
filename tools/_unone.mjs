// units agent: the same frame with units.group hidden, so a failing metric region can be
// attributed. node tools/_unone.mjs out.png
import { chromium } from 'playwright';
const [, , out = 'shots/_unone.png'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 6, null, { timeout: 240000 }).catch(() => {});
await p.evaluate(() => { setInterval(() => { window.units.group.visible = false; }, 40); });
const f0 = await p.evaluate(() => window.__frameCount || 0);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, f0 + 28, { timeout: 300000 }).catch(() => {});
await p.screenshot({ path: out, timeout: 180000 });
console.log(out);
await b.close();
