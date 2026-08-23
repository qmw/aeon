import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=10,null,{timeout:300000}).catch(()=>{});
const wait=()=>p.evaluate(()=>new Promise(r=>{const n=window.__frameCount;const t=setInterval(()=>{if(window.__frameCount>n+4){clearInterval(t);r();}},100);}));
await p.evaluate(()=>{document.querySelectorAll('#hud,.hud,#ui').forEach(e=>e.style.display='none');});
const A=await p.screenshot({type:'png'});
await p.evaluate(()=>{window.scene.traverse(o=>{if(o.isDirectionalLight)o.castShadow=false;});});
await wait(); const B=await p.screenshot({type:'png'});
const d=await p.evaluate(async ([a,bb])=>{
  const load=x=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+x;});
  const ia=await load(a),ib=await load(bb);
  const c=document.createElement('canvas');c.width=ia.width;c.height=ia.height;
  const g=c.getContext('2d',{willReadFrequently:true});
  g.drawImage(ia,0,0);const da=g.getImageData(0,0,c.width,c.height);
  g.clearRect(0,0,c.width,c.height);g.drawImage(ib,0,0);const db=g.getImageData(0,0,c.width,c.height).data;
  const o=da.data;
  for(let i=0;i<o.length;i+=4){const la=0.2126*o[i]+0.7152*o[i+1]+0.0722*o[i+2];
    const lb=0.2126*db[i]+0.7152*db[i+1]+0.0722*db[i+2];const v=Math.max(0,Math.min(255,(lb-la)*2));
    o[i]=v;o[i+1]=v;o[i+2]=v;o[i+3]=255;}
  g.putImageData(da,0,0);return c.toDataURL('image/png');
},[A.toString('base64'),B.toString('base64')]);
writeFileSync('/home/piotr/looping_opus_5_test/shots/_tshadmask.png',Buffer.from(d.split(',')[1],'base64'));
console.log('ok');
await b.close();
