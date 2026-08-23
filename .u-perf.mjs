import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
p.on('console',m=>{if(m.type()==='error'&&!/favicon|Failed to load/.test(m.text()))errors.push(m.text());});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
await p.waitForTimeout(12000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const U=window.units,R=window.renderer;
  let mine=0,tris=0; U.group.traverse(o=>{if(o.isMesh||o.isSprite){mine++; if(o.geometry){const g=o.geometry; const c=(o.isInstancedMesh?o.count:1)*((g.index?g.index.count:g.attributes.position.count)/3); tris+=c;}}});
  // with-units vs without
  const gl=R.getContext(); const px=new Uint8Array(4);
  const bench=(n)=>{const t=performance.now(); for(let i=0;i<n;i++){R.render(window.scene,window.camera); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);} return (performance.now()-t)/n;};
  bench(2);
  const withU=bench(6);
  U.group.visible=false; const noU=bench(6); U.group.visible=true;
  for(const k in U.prim) U.prim[k].mesh.castShadow=false; for(const e of U.bmesh.values()) e.mesh.castShadow=false;
  const noCast=bench(6);
  for(const k in U.prim) U.prim[k].mesh.castShadow=true; for(const e of U.bmesh.values()) e.mesh.castShadow=true;
  U.puffs.mesh.visible=false; U.decals.mesh.visible=false; U.flags.mesh.visible=false;
  const noFx=bench(6); U.puffs.mesh.visible=true; U.decals.mesh.visible=true; U.flags.mesh.visible=true;
  Object.assign(window,{__noCast:noCast,__noFx:noFx});
  return {fps:window.__fps, myMeshes:mine, myTris:Math.round(tris), msWithUnits:+withU.toFixed(1), msWithout:+noU.toFixed(1), msNoCast:+noCast.toFixed(1), msNoFx:+noFx.toFixed(1),
    units:U.units.size, cities:U.cities.length, progs:R.info.programs.length, mem:R.info.memory};
}),null,1));
console.log('errors',errors.slice(0,6));
await b.close();
