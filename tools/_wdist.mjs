import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('ERR', String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__ready && window.camera, null, { timeout: 90000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const THREE = window.THREE, cam = window.camera;
  const pts = [[1150,210],[1000,280],[960,700],[600,420],[1300,120],[1100,110],[820,760],[1250,780]];
  const rc = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0,1,0), -0.10);
  const hit = new THREE.Vector3();
  return pts.map(([x,y]) => {
    rc.setFromCamera(new THREE.Vector2(x/1600*2-1, -(y/900*2-1)), cam);
    const ok = rc.ray.intersectPlane(plane, hit);
    const A=hit.clone(); rc.setFromCamera(new THREE.Vector2((x+1)/1600*2-1, -(y/900*2-1)), cam); const B=new THREE.Vector3(); rc.ray.intersectPlane(plane,B); rc.setFromCamera(new THREE.Vector2(x/1600*2-1, -((y+1)/900*2-1)), cam); const C=new THREE.Vector3(); rc.ray.intersectPlane(plane,C); const fw=Math.max(Math.abs(B.x-A.x)+Math.abs(C.x-A.x), Math.abs(B.z-A.z)+Math.abs(C.z-A.z)); return { px:[x,y], d: ok ? +hit.distanceTo(cam.position).toFixed(1) : null, fw:+fw.toFixed(4) };
  });
}), null, 0));
await b.close();
