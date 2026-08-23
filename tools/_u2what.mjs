import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=6,null,{timeout:300000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(()=>{
  const C=window.camera,T=window.THREE;
  const out=[];
  window.scene.traverse(o=>{
    if(!o.visible) return;
    const w=new T.Vector3(); o.getWorldPosition(w);
    const v=w.clone().project(C);
    const px=(v.x*.5+.5)*1600, py=(.5-v.y*.5)*900;
    if(v.z>1||v.z<-1) return;
    if(o.type!=='Sprite'&&o.type!=='Mesh') return;
    out.push({n:o.name||'',t:o.type,px:[Math.round(px),Math.round(py)],par:o.parent?.name||o.parent?.type});
  });
  return out;
}),null,1));
await b.close();
