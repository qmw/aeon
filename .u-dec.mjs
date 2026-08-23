import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:600,height:400}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
await p.waitForTimeout(7000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const D=window.units.decals, U=window.units;
  const out=[];
  for(let i=0;i<Math.min(8,D.mesh.count);i++){
    const m=new window.THREE.Matrix4(); D.mesh.getMatrixAt(i,m);
    const e=m.elements;
    out.push({i,mode:D.k.getX(i),col:[D.c.getX(i),D.c.getY(i),D.c.getZ(i)].map(v=>+v.toFixed(3)),k:+D.c.getW(i).toFixed(3),pos:[e[12],e[13],e[14]].map(v=>+v.toFixed(3)),sx:+Math.hypot(e[0],e[1],e[2]).toFixed(3)});
  }
  const u=[...U.units.values()][3];
  return {count:D.mesh.count, out, sample:{id:u.id,y:u.y,yMax:u.yMax,water:u.water,gN:u.gN,scale:u.scale,foot:u.def.foot},
    mat:{dt:D.mesh.material.depthTest,tr:D.mesh.material.transparent,dw:D.mesh.material.depthWrite,ro:D.mesh.renderOrder,vis:D.mesh.visible},
    parentVis: D.mesh.parent && D.mesh.parent.visible};
}),null,1));
await b.close();
