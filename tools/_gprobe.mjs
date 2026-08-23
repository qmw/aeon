// probe: grid uniforms + camera + on-screen hex size, live.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(n => (window.__frameCount||0) >= n, +(process.env.F||6), { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, g = window.input?.grid, cam = window.camera, map = window.map;
  const u = g.uniforms;
  // hex screen size at frame centre: project two points 1 world unit apart on the ground
  const probe = (nx, ny) => {
    const rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2(nx, ny), cam);
    const pl = new T.Plane(new T.Vector3(0,1,0), -0.6); const hit = new T.Vector3();
    if (!rc.ray.intersectPlane(pl, hit)) return null;
    const a = hit.clone(), c2 = hit.clone().add(new T.Vector3(1,0,0));
    const pa = a.clone().project(cam), pb = c2.clone().project(cam);
    const dpx = Math.hypot((pb.x-pa.x)*400, (pb.y-pa.y)*225);
    return { world: [+hit.x.toFixed(1), +hit.z.toFixed(1)], dist: +cam.position.distanceTo(hit).toFixed(1), pxPerUnit: +dpx.toFixed(1) };
  };
  // per-tile fade histogram from the built geometry
  let meshes = 0, verts = 0;
  const fh = {};
  g.group.traverse(o => { if (o.geometry?.attributes?.aFade) { meshes++; const a = o.geometry.attributes.aFade.array; verts += a.length;
    for (let i=0;i<a.length;i+=25){ const k = (Math.abs(a[i])*10|0)/10; fh[k]=(fh[k]||0)+1; } } });
  return { camY: +cam.position.y.toFixed(1), camDist: +u.uDist.value.toFixed(1), fov: cam.fov,
    uGrid: +u.uGrid.value.toFixed(3), uFar: +u.uFar.value.toFixed(1), uBias: u.uBias.value,
    zoom: window.input?.zoom, tiles: map.tiles.length, meshes, verts,
    fadeHist: fh,
    centre: probe(0,0), bottom: probe(0,-0.6), top: probe(0,0.55), farL: probe(-0.7,0.5) };
})), null);
await b.close();
