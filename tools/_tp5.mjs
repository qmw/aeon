import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const url = process.argv[2] || 'http://localhost:5173/';
await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction("(window.__frameCount||0) >= 20", null, { timeout: 180000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, cam = window.camera, r = window.renderer;
  const out = { maxAniso: r.capabilities.getMaxAnisotropy(), camPos: cam.position.toArray().map(v=>+v.toFixed(2)), fov: cam.fov, pts: [] };
  const rc = new T.Raycaster();
  const terr = window.__terrain;
  const targets = []; terr.group.traverse(o => { if (o.name === 'terrain-surface' || o.name === 'terrain-cliffs') targets.push(o); });
  for (const [sx, sy] of [[800,860],[800,700],[800,500],[800,300],[800,150],[200,800],[1300,800],[200,200]]) {
    rc.setFromCamera(new T.Vector2(sx/800-1, 1-sy/450), cam);
    const h = rc.intersectObjects(targets, true)[0];
    if (h) out.pts.push({ s:[sx,sy], d: +h.distance.toFixed(1), y: +h.point.y.toFixed(2) });
    else out.pts.push({ s:[sx,sy], d: null });
  }
  // world units per screen pixel at each depth
  out.px = out.pts.map(q => q.d ? +(2*q.d*Math.tan(cam.fov*Math.PI/360)/900).toFixed(4) : null);
  return out;
}), null, 1));
await b.close();
