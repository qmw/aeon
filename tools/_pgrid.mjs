// scratch(post): what state is the grid decal actually carrying this frame?
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,400)));
p.on('console', m => { if (m.type()==='error') console.log('CON', m.text().slice(0,400)); });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 2, null, { timeout: 240000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.input.grid, st = g.state, u = g.uniforms;
  let border = 0, rmask = 0, rng = 0, hov = 0, sel = 0, wrk = 0;
  for (let i = 0; i < st.length; i += 4) {
    if (st[i]) rng++; if (st[i+1]) rmask++; if (st[i+3]) border++;
    const fl = st[i+2]; if (fl & 1) hov++; if (fl & 2) sel++; if (fl & 4) wrk++;
  }
  const prog = g.mat.program;
  return { tiles: st.length/4, rng, rmask, border, hov, sel, wrk,
    uGrid: u.uGrid.value, uDist: u.uDist.value, uFar: u.uFar.value, uDim: u.uDim.value,
    uCurR: u.uCurR.value, cursor: [u.uCursor.value.x, u.uCursor.value.y],
    blending: g.mat.blending, meshes: g.group.children.length,
    diag: prog ? prog.diagnostics : null };
}), null, 1));
await b.close();
