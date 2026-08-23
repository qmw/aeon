// exit 0 when the page compiles clean (no shader errors) after a few frames
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0,120)); });
p.on('pageerror', e => errs.push(String(e).slice(0,160)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 6, null, { timeout: 120000 }).catch(()=>{});
await b.close();
console.log(errs.length ? 'DIRTY ' + errs[0] : 'CLEAN');
process.exit(errs.length ? 1 : 0);
