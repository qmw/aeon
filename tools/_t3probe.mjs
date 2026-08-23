// hide one terrain sub-mesh by name, then screenshot. node tools/_t3probe.mjs out.png meshName [frames]
import { chromium } from 'playwright';
const [, , out = 'shots/.probe.png', name = 'terrain-worked', frames = '14'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(n => (window.__frameCount || 0) >= n, +frames, { timeout: 180000 }).catch(() => {});
const hit = await p.evaluate((nm) => {
  let n = 0;
  let root = window.__terrain?.group; while (root?.parent) root = root.parent;
  root?.traverse(o => { if (new RegExp(nm).test(o.name)) { o.visible = false; n++; } });
  window.__frameCount = 0;
  return n;
}, name);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, +frames, { timeout: 180000 }).catch(() => {});
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, hidden: hit }));
await b.close();
