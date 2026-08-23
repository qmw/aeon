// node .ptweak.mjs out.png '<js applied to page after load>'
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,, out, js = '', wait = '9000'] = process.argv;
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(6000);
if (js) await p.evaluate(js);
await p.waitForTimeout(+wait);
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, errs, fps: await p.evaluate(() => window.__mspf) }));
await b.close();
