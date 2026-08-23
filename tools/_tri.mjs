import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
const errors=[];p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=8,null,{timeout:150000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(()=>{
  const U=window.units,i=window.renderer.info.render;
  let ut=0; U.group.traverse(o=>{if(o.geometry&&o.count!==0){const g=o.geometry;const n=g.index?g.index.count/3:g.attributes.position.count/3;ut+=n*(o.isInstancedMesh?o.count:1);}});
  const bm={}; for(const [k,e] of U.bmesh) bm[k]=[e.mesh.count,(e.mesh.geometry.index?e.mesh.geometry.index.count/3:e.mesh.geometry.attributes.position.count/3)|0];
  return {tris:i.triangles,calls:i.calls,unitsTris:ut|0,bm,fps:window.__fps,mspf:window.__mspf};
}),null,1));
console.log('ERR',JSON.stringify(errors.slice(0,6)));
await b.close();
