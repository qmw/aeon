// silhouette gate: every unit type as a flat black shape, side by side, at gameplay px size
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const [,, out='shots/.sil.png', dist='11', px='1600', ph='300'] = process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:+px,height:+ph}});
const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
await p.waitForTimeout(6000);
const info = await p.evaluate((dist)=>{
  const U=window.units, T=window.THREE, S=window.scene;
  if (window.input) window.input.update=()=>{};
  for (const el of document.body.children) if (el.tagName!=='CANVAS') el.style.display='none';
  const M=window.map, hx=(q,r)=>({x:1.5*q, z:Math.sqrt(3)*(r+q/2)});
  let best=null,bs=1e9;
  for(let r=8;r<M.h-8;r++)for(let q=6;q<M.w-12;q++){let ok=true,hs=[];
    for(let k=0;k<9;k++){const t=M.get(q+k,r-((k/2)|0)); if(!t||t.height<=0.05||t.feature){ok=false;break;} hs.push(t.height);} 
    if(!ok)continue; const v=Math.max(...hs)-Math.min(...hs); if(v<bs){bs=v;best={q,r};}}
  // wipe the board, then line the roster up
  for (const id of [...U.units.keys()]) U.remove(id);
  const types=['warrior','spearman','archer','horseman','settler','builder','catapult','trireme'];
  types.forEach((t,i)=>U.add({type:t,q:best.q+i,r:best.r-((i/2)|0),team:0,yaw:1.15}));
  U.update(0.016);
  // flat black everything of mine, white world
  const black=new T.MeshBasicMaterial({color:0});
  U.group.traverse(o=>{ if(o.isMesh){ o.userData._m=o.material; o.material=black; }});
  S.background=new T.Color(0xffffff);
  for (const o of S.children) if (o!==U.group && o.name!=='units') o.visible=false;
  U.flags.mesh.visible=false; U.decals.mesh.visible=false; U.puffs.mesh.visible=false;
  for (const c of U.cities) if (c.plate) c.plate.visible=false;
  const c0=hx(best.q,best.r), c1=hx(best.q+7,best.r-3);
  const cx=(c0.x+c1.x)/2, cz=(c0.z+c1.z)/2, gy=window.terrain.heightAt(cx,cz);
  const c=window.camera, py=16.5*Math.PI/180;
  c.position.set(cx, gy+0.55+Math.sin(py)*dist, cz+Math.cos(py)*dist);
  c.lookAt(cx,gy+0.55,cz); c.near=0.1; c.fov=37; c.updateProjectionMatrix();
  window.post && (window.post.render=()=>window.renderer.render(S,c));
  return {best};
},+dist);
await p.waitForTimeout(1500);
await p.screenshot({path:out});
console.log(JSON.stringify({out,bytes:statSync(out).size,...info,errors:errors.slice(0,5)}));
await b.close();
