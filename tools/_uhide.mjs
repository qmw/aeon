import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const what = process.argv[2] || 'field';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(()=>window.units && window.units.cities.length, null, {timeout:90000});
await p.evaluate((w) => {
  const U = window.units;
  if (w === 'shadows') U.shadows.mesh.visible = false;
  else if (w === 'terr') window.terrain.group.traverse(o=>{ if(/decal|contact|work|improv/i.test(o.name)) o.visible=false; });
  else U.bmesh.get(w)?.mesh && (U.bmesh.get(w).mesh.visible = false);
  document.querySelectorAll('#hud').forEach(e=>e.style.display='none');
}, what);
await p.waitForTimeout(9000);
await p.screenshot({ path: '/tmp/hide_'+what+'.png' });
console.log('ok /tmp/hide_'+what+'.png');
await b.close();
