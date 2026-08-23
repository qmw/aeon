import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(12000);
console.log(JSON.stringify(await p.evaluate(() => {
  const r = window.renderer, info = r.info;
  const passes = window.post?.composer?.passes?.map(x => ({ n: x.constructor.name, on: x.enabled })) ?? null;
  let tris = 0, meshes = 0, mats = new Set();
  window.scene.traverse(o => { if (o.isMesh || o.isInstancedMesh) { meshes++; mats.add(o.material?.uuid); const g = o.geometry; if (g?.index) tris += g.index.count / 3 * (o.count || 1); else if (g?.attributes?.position) tris += g.attributes.position.count / 3 * (o.count || 1); } });
  return { fps: window.__fps, calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length, textures: info.memory.textures, geometries: info.memory.geometries, sceneMeshes: meshes, sceneTris: Math.round(tris), materials: mats.size, pixelRatio: r.getPixelRatio(), size: r.getSize(new window.THREE.Vector2()).toArray(), passes };
}), null, 1));
await b.close();
