// Framing solver: load once, sweep camera params, project subjects, score. No rendering.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__ready&&(window.__frameCount||0)>=3,null,{timeout:180000}).catch(()=>{});
const res = await p.evaluate(({sweep})=>{
 const {map,input,camera,game,THREE}=window;
 const PANELS=[[0,0,1600,72],[22,674,394,878],[1272,74,1578,288],[1292,579,1578,878]];
 const clear=(x,y)=>x>8&&x<1592&&y>8&&y<892&&!PANELS.some(P=>x>P[0]-6&&x<P[2]+6&&y>P[1]-6&&y<P[3]+6);
 const A=(q,r)=>({x:1.5*q,z:Math.sqrt(3)*(r+q/2)});
 const v=new THREE.Vector3();
 const proj=(x,y,z)=>{v.set(x,y,z).project(camera);return[(v.x*.5+.5)*1600,(-v.y*.5+.5)*900,v.z];};
 const named={};
 for(const c of game.cities.filter(c=>!c.dead)) named[c.name]={...A(c.q,c.r),h:map.tiles[c.i].height};
 const sel=game.state.selectedUnit; const S={...A(sel.q,sel.r),h:map.tiles[sel.i].height};
 const mtn=map.tiles.filter(t=>t.biome==='mountain').map(t=>({...A(t.q,t.r),h:t.height}));
 const hills=map.tiles.filter(t=>t.biome==='hills'&&t.height>3.2).map(t=>({...A(t.q,t.r),h:t.height}));
 const water=map.tiles.filter(t=>t.height===0).map(t=>({...A(t.q,t.r),h:0.1}));
 const river=map.tiles.filter(t=>t.river&&t.height>0).map(t=>({...A(t.q,t.r),h:t.height}));
 const out=[];
 for(const s of sweep){
  input.zoom=input.zoomT=s.z; input.yaw=s.yaw; input.tilt=s.tilt;
  input.focus.set(s.x, input._ground(s.x,s.zz), s.zz); input._place();
  camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const P=o=>proj(o.x,o.h,o.z);
  const rec={...s};
  for(const k of ['Aurelia','Calyx','Solmere','Vantis','Iridon']){const q=named[k];if(!q)continue;const [a,c]=P(q);rec[k]=[Math.round(a),Math.round(c),clear(a,c)?1:0];}
  const [ux,uy]=P(S); rec.unit=[Math.round(ux),Math.round(uy),clear(ux,uy)?1:0];
  let m=0,mtop=0; for(const q of mtn){const[a,c,d]=P(q); if(d<1&&a>-40&&a<1640&&c>20&&c<340){m++; if(c<200)mtop++;}}
  rec.mtn=m; rec.mtnTop=mtop;
  let h=0; for(const q of hills){const[a,c,d]=P(q); if(d<1&&a>0&&a<1600&&c>20&&c<380)h++;}
  rec.hills=h;
  let w=0; for(const q of water){const[a,c,d]=P(q); if(d<1&&clear(a,c))w++;}
  rec.water=w;
  let rv=0; for(const q of river){const[a,c,d]=P(q); if(d<1&&clear(a,c))rv++;}
  rec.river=rv;
  out.push(rec);
 }
 return out;
}, {sweep: JSON.parse(process.env.SWEEP)});
console.log(JSON.stringify(res));
await b.close();
