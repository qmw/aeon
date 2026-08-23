// try candidate framings in one page load; print where everything lands in screen px
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const cands = JSON.parse(process.argv[2]);
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__ready, null, { timeout: 120000 }).catch(()=>{});
await p.waitForTimeout(3000);
console.log(await p.evaluate(async (cands) => {
  const { units, THREE, camera, input, game, map } = window;
  const hex = await import('/src/world/hex.js');
  const v = new THREE.Vector3();
  const px = (x,y,z) => { v.set(x,y,z).project(camera); return [Math.round((v.x*.5+.5)*1600), Math.round((.5-v.y*.5)*900), +v.z.toFixed(2)]; };
  const vis = game.civs[0].vis;
  const mts = map.tiles.filter(t=>t.biome==='mountain'&&vis[t.i]>0);
  const out = [];
  for (const [Z,X,ZZ] of cands) {
    input.zoom = input.zoomT = Z;
    input.focus.set(X, input._ground(X,ZZ), ZZ);
    input._place();
    camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    const lines = [`--- zoom ${Z} focus ${X},${ZZ} dist=${input.dist.toFixed(1)} pitch=${(input.pitch*180/Math.PI).toFixed(1)}`];
    for (const c of units.cities) { const a = px(c.plate.position.x, c.plate.position.y, c.plate.position.z); lines.push(`  plate ${c.name} ${a[0]},${a[1]}${a[2]>1?' OFF':''}`); }
    const u = game.state.selectedUnit; if (u) { const w = hex.axialToWorld(u.q,u.r); const a = px(w.x, units.y(w.x,w.z)+0.4, w.z); lines.push(`  UNIT ${u.type} ${a[0]},${a[1]}`); }
    // mountain mass: bbox of visible mountain tiles on screen
    let x0=9e9,y0=9e9,x1=-9e9,y1=-9e9,n=0;
    for (const t of mts) { const w = hex.axialToWorld(t.q,t.r); const a = px(w.x, t.height, w.z);
      if (a[2]>1) continue; n++; x0=Math.min(x0,a[0]);x1=Math.max(x1,a[0]);y0=Math.min(y0,a[1]);y1=Math.max(y1,a[1]); }
    lines.push(`  mountains n=${n} bbox ${x0},${y0} .. ${x1},${y1}`);
    out.push(lines.join('\n'));
  }
  return out.join('\n');
}, cands));
await b.close();
