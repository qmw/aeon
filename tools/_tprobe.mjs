// scratch: terrain pool + triangle probe
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction("(window.__frameCount||0) >= 22", null, { timeout: 180000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const t = window.__terrain, out = { pools: [], vis: t._vis.length, tris: 0, mspf: window.__mspf };
  for (const q of t._pools) out.pools.push([q.mesh.name, q.mesh.count, q.cap, q.byTile.size]);
  window.scene.traverse(o => {
    if (!o.visible || !o.geometry) return;
    const idx = o.geometry.index ? o.geometry.index.count : (o.geometry.attributes.position?.count || 0);
    out.tris += (idx / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  out.tris = Math.round(out.tris);
  const g = window.game;
  out.worked = g ? [...g.workedBy].filter(v => v >= 0).length : -1;
  // where are the plinths on screen?
  out.screen = [];
  const T = window.THREE, v = new T.Vector3(), m = new T.Matrix4();
  for (const q of t._pools) {
    if (!/plinth/.test(q.mesh.name)) continue;
    for (let n = 0; n < q.mesh.count; n++) {
      q.mesh.getMatrixAt(n, m); v.setFromMatrixPosition(m).project(window.camera);
      const sx = Math.round((v.x * 0.5 + 0.5) * 1600), sy = Math.round((-v.y * 0.5 + 0.5) * 900);
      if (sx > 0 && sx < 1600 && sy > 0 && sy < 900) out.screen.push([sx, sy]);
    }
  }
  return out;
})));
await b.close();
