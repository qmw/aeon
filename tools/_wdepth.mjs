import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction('window.__ready===true',{timeout:60000});
await p.waitForTimeout(4000);
console.log(JSON.stringify(await p.evaluate((pts)=>{
  const T=window.THREE, cam=window.camera, w=window.water, u=w.u;
  const img=u.uField.value.image, d=img.data, W=img.width, H=img.height;
  const min=u.uFieldMin.value, size=u.uFieldSize.value;
  const fld=(x,z)=>{ const fx=Math.min(W-1,Math.max(0,Math.round((x-min.x)/size.x*W-0.5)));
    const fz=Math.min(H-1,Math.max(0,Math.round((z-min.y)/size.y*H-0.5))); const i=(fz*W+fx)*4;
    return {sd:+((d[i]/255-0.5)*8).toFixed(3), bed:+((d[i+1]/255*10)-3).toFixed(3), alb:+(d[i+2]/255).toFixed(2)}; };
  const out=[];
  for(const [sx,sy] of pts){
    const ndc=new T.Vector3(sx/1600*2-1, -(sy/900*2-1), 0.5).unproject(cam);
    const dir=ndc.sub(cam.position).normalize();
    const hits=[];
    for(const y of [0.10]){ const t=(y-cam.position.y)/dir.y; const P=cam.position.clone().addScaledVector(dir,t); hits.push(P); }
    const P=hits[0];
    const f=fld(P.x,P.z);
    // which tile?
    const hx=window.map; let best=null,bd=1e9;
    for(const tt of hx.tiles){ const q=tt.q, r=tt.r; }
    out.push({screen:[sx,sy], world:[+P.x.toFixed(2),+P.z.toFixed(2)], ...f});
  }
  // dump the water mesh attributes near those points
  const sea=w.group.children[0];
  const pos=sea.geometry.attributes.position.array, lake=sea.geometry.attributes.aLake.array,
        open=sea.geometry.attributes.aOpen.array, body=sea.geometry.attributes.aBody.array;
  for(const o of out){
    let bi=-1,bd=1e9;
    for(let i=0;i<pos.length;i+=3){ const dx=pos[i]-o.world[0], dz=pos[i+2]-o.world[1]; const dd=dx*dx+dz*dz; if(dd<bd){bd=dd;bi=i/3;} }
    o.vert={y:+pos[bi*3+1].toFixed(3), lake:lake[bi], open:+open[bi].toFixed(2), body:+body[bi].toFixed(2), dist:+Math.sqrt(bd).toFixed(2)};
    o.depth=+(o.vert.y-o.bed).toFixed(3);
  }
  return out;
}, [[800,650],[760,600],[880,700],[1200,300],[1450,320],[1100,200],[980,470]])));
await b.close();
