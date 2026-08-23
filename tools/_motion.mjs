// scratch: screenshot WHILE the camera is easing, to look for TAA smear.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs=[]; p.on('pageerror', e=>errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(9000);
await p.evaluate(() => { window.input.zoomT = 0.85; });
await p.waitForTimeout(1500);
await p.screenshot({ path: 'shots/zz_motion.png' });
console.log(JSON.stringify({ mspf: await p.evaluate(()=>window.__mspf), errs: errs.slice(0,3) }));
await b.close();
