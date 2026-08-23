// Same contract as tools/shot.mjs, but patient: SwiftShader is currently taking ~1s/frame for
// the whole scene, and the stock 30s screenshot timeout trips on it.
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const [,, out='shots/units-p2r2.png', w='1600', h='900', wait='9000'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width:+w, height:+h } });
p.setDefaultTimeout(180000);
const errors=[];
p.on('console', m=>{ if(m.type()==='error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e=>errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil:'load', timeout:120000 });
await p.waitForTimeout(+wait);
await p.screenshot({ path: out, timeout: 180000, animations: 'allow', caret: 'initial' });
const bytes = statSync(out).size;
const fps = await p.evaluate(() => window.__fps ?? null);
console.log(JSON.stringify({ out, bytes, blank: bytes < 20000, fps, errors: errors.slice(0,12) }));
await b.close();
