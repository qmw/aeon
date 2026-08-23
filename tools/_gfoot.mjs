// grid/post scratch: measured texel footprint (eye depth / n.v) over each gate region.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,200)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 4, null, { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, cam = window.camera;
  const R = { 'far-cliff':[60,90,240,160], mid:[380,380,240,160], 'near-field':[700,700,240,160], water:[1150,200,240,160] };
  const rc = new T.Raycaster();
  const targets = [window.terrain?.group, window.water?.group].filter(Boolean);
  const out = { camY:+cam.position.y.toFixed(1) };
  for (const k in R) {
    const [X,Y,W,H] = R[k]; const fs = [];
    for (let j = 0; j < 8; j++) for (let i = 0; i < 12; i++) {
      const x = X + (i+0.5)*W/12, y = Y + (j+0.5)*H/8;
      rc.setFromCamera(new T.Vector2(x/1600*2-1, -(y/900*2-1)), cam);
      const h = rc.intersectObjects(targets, true).find(o=>o.distance>0.5);
      if (!h || !h.face) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).transformDirection(cam.matrixWorldInverse);
      const v = h.point.clone().applyMatrix4(cam.matrixWorldInverse);
      const d = -v.z, nv = Math.max(Math.abs(n.dot(v.clone().normalize().negate())), 0.16);
      fs.push(d/nv);
    }
    fs.sort((a,b)=>a-b);
    out[k] = { n: fs.length, p25: +fs[(fs.length*0.25)|0]?.toFixed(1), med: +fs[(fs.length/2)|0]?.toFixed(1), p75: +fs[(fs.length*0.75)|0]?.toFixed(1) };
  }
  return out;
}), null, 1));
await b.close();
