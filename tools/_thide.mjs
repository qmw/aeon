// terrain scratch: screenshot with some terrain meshes hidden. node tools/_thide.mjs out.png <regex> [frames]
import { chromium } from 'playwright';
const [, , out, re = 'none', frames = '10'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 2, null, { timeout: 240000 }).catch(()=>{});
await p.evaluate(r => { const rx = new RegExp(r); window.terrain.group.traverse(o => { if ((o.isMesh||o.isInstancedMesh) && rx.test(o.name)) o.visible = false; }); }, re);
await p.evaluate(n => { window.__frameCount = 0; }, 0);
await p.waitForFunction(n => (window.__frameCount||0) >= n, +frames, { timeout: 240000 }).catch(()=>{});
await p.screenshot({ path: out, timeout: 120000 });
console.log(out);
await b.close();
