// scratch: crop+zoom a png. node tools/_zcrop.mjs in.png out.png x y w h [scale]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , inp, out, x, y, w, h, sc = '3'] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage({ viewport: { width: Math.round(+w * +sc), height: Math.round(+h * +sc) } });
await p.setContent(`<body style="margin:0;overflow:hidden"><img style="position:absolute;image-rendering:pixelated;left:${-x * sc}px;top:${-y * sc}px;transform-origin:0 0;transform:scale(${sc})" src="data:image/png;base64,${b64}">`);
await p.waitForTimeout(400);
await p.screenshot({ path: out });
await br.close();
console.log(out);
