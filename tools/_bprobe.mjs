import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=> (window.__frameCount||0)>=8,null,{timeout:180000}).catch(()=>{});
const r = await p.evaluate(()=>{
  const out={};
  // what does a ray through the suspect pixels hit?
  const rc = new THREE.Raycaster();
  const pts=[[155,90],[60,120],[240,80],[130,180],[420,110],[700,300]];
  out.hits = pts.map(([px,py])=>{
    const ndc=new THREE.Vector2(px/1600*2-1, -(py/900*2-1));
    rc.setFromCamera(ndc,camera);
    const hs=rc.intersectObjects(scene.children,true).filter(h=>h.object.visible);
    return [px,py,hs.slice(0,3).map(h=>`${h.object.name||h.object.type}#${h.object.id}/${h.object.material?.type}@${h.distance.toFixed(1)}`)];
  });
  // list top-level scene children with names
  out.kids = scene.children.map(o=>`${o.name||o.type}#${o.id} vis=${o.visible} kids=${o.children.length}`);
  return out;
});
console.log(JSON.stringify(r,null,1));
await b.close();
