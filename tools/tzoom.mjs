// terrain-agent crop tool: node tools/tzoom.mjs out.png x y w h [scale]
import { chromium } from 'playwright';
const [, , out = 'shots/z.png', x = 0, y = 0, w = 400, h = 300, scale = 3] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: +scale });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(11000);
await p.screenshot({ path: 'shots/_warm.png' });
await p.waitForTimeout(3000);
await p.screenshot({ path: out, clip: { x: +x, y: +y, width: +w, height: +h } });
console.log(out);
await b.close();
