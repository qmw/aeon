// units agent: dump the per-part instance colours of one unit, so a white blob can be traced
// to its albedo instead of guessed at. node tools/_ucol.mjs [type]
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && window.units.units.size, null, { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(kind => {
  const U = window.units;
  const u = [...U.units.values()].find(x => x.type === kind) || [...U.units.values()][0];
  const rows = u.def.parts.map((pt, i) => {
    const pr = U.prim[pt.g], s = u.slots[i], a = pr.mesh.instanceColor.array;
    const r = a[s*3], g = a[s*3+1], bb = a[s*3+2];
    const mx = Math.max(r,g,bb), mn = Math.min(r,g,bb);
    return { g: pt.g, b: pt.b, src: typeof pt.c === 'string' ? pt.c : '#'+pt.c.toString(16),
      z: pt.mr[3]||0, rough: +pt.mr[1].toFixed(2), met: pt.mr[0],
      rgb: [r,g,bb].map(v=>+v.toFixed(3)), l: +((mx+mn)/2).toFixed(3) };
  });
  return { type: u.type, bv: +u.def._bv.toFixed(3), gv: u.gv, rows };
}, process.argv[2] || 'warrior'), null, 0).replace(/},/g,'},\n'));
await b.close();
