import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=6,null,{timeout:300000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(()=>{
  const U=window.units,C=window.camera;
  const out={fov:C.fov,pxk:U._pxk,lean:U._lean,cam:[C.position.x,C.position.y,C.position.z].map(v=>+v.toFixed(1))};
  out.units=[];
  for(const u of U.units.values()){
    const v=new (U.group.position.constructor)(u.x,u.y,u.z).project(C);
    const px=(v.x*.5+.5)*1600,py=(.5-v.y*.5)*900;
    if(px<0||px>1600||py<0||py>900) continue;
    const dist=Math.hypot(C.position.x-u.x,C.position.y-u.y,C.position.z-u.z);
    const usc=u.scale*(u.ds??1);
    const cut=6.0*dist/(U._pxk*usc);
    const parts=u.def.parts;
    let kept=0,tot=parts.length;
    const dropped={};
    for(const q of parts){const sz=Math.max(Math.abs(q.m.elements[0]),Math.abs(q.m.elements[5]),Math.abs(q.m.elements[10]));if(sz>=cut)kept++;else dropped[q.g]=(dropped[q.g]||0)+1;}
    out.units.push({id:u.id,type:u.type,px:[Math.round(px),Math.round(py)],dist:+dist.toFixed(1),usc:+usc.toFixed(2),cut:+cut.toFixed(4),kept,tot,dropped});
  }
  return out;
}),null,1));
await b.close();
