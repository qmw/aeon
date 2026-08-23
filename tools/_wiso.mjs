// runtime-only layer isolation: node tools/_wiso.mjs out.png "js"   (edits nothing on disk)
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [, , out = 'shots/_iso.png', js = ''] = process.argv;
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
for (let attempt = 0; attempt < 4; attempt++) {
  try {
    await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
    await p.waitForFunction('window.__ready === true', { timeout: 60000 });
    await p.waitForTimeout(9000);
    if (js) await p.evaluate(js);
    await p.waitForTimeout(4500);
    const shot = await p.screenshot({ path: out });
    if (shot.length > 20000) break;
  } catch (e) { errs.push(String(e).slice(0, 90)); }
}
console.log(JSON.stringify({ out, errs: errs.slice(0, 3) }));
await b.close();
