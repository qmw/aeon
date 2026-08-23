import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(()=>window.units && window.units.cities.length, null, {timeout:90000});
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(() => {
  const out = [];
  window.scene.traverse(o => {
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) if (m.blending === 4 /*Multiply*/) out.push({ n: o.name || o.type, mat: m.type, pa: m.premultipliedAlpha, cnt: o.count });
  });
  const U = window.units;
  return { multiply: out, shadowsPA: U.shadows.mesh.material.premultipliedAlpha, shadowsBlend: U.shadows.mesh.material.blending,
           shadowN: U.shadows.n, decalN: U.decals.n };
}), null, 1));
await b.close();
