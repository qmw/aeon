import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1200, height: 675 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 10, null, { timeout: 180000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const out = { unitsGroup: null, byGroup: {} };
  const walk = (root, label) => {
    let cast = 0, nocast = 0, recv = 0, names = [];
    root.traverse(o => {
      if (!(o.isMesh || o.isInstancedMesh)) return;
      if (o.castShadow) cast++; else { nocast++; if (names.length < 6) names.push((o.name || o.type) + (o.isInstancedMesh ? `[x${o.count}]` : '')); }
      if (o.receiveShadow) recv++;
    });
    out.byGroup[label] = { cast, nocast, recv, sampleNotCasting: names };
  };
  if (window.units?.group) walk(window.units.group, 'units');
  if (window.terrain?.group) walk(window.terrain.group, 'terrain');
  if (window.fx?.group) walk(window.fx.group, 'fx');
  const sun = window.scene.children.find(o => o.isDirectionalLight);
  out.sun = sun ? { intensity: sun.intensity, castShadow: sun.castShadow, mapSize: sun.shadow.mapSize.toArray(), cam: [sun.shadow.camera.left, sun.shadow.camera.right, sun.shadow.camera.top, sun.shadow.camera.bottom].map(n => +n.toFixed(1)), normalBias: +sun.shadow.normalBias.toFixed(4) } : null;
  return out;
}), null, 1));
await b.close();
