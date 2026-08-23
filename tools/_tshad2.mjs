import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1200,height:675}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=10,null,{timeout:300000}).catch(()=>{});
const wait=()=>p.evaluate(()=>new Promise(r=>{const n=window.__frameCount;const t=setInterval(()=>{if(window.__frameCount>n+4){clearInterval(t);r();}},100);}));
const A=await p.screenshot({type:'png'});
await p.evaluate(()=>{window.scene.traverse(o=>{if(o.isDirectionalLight)o.castShadow=false;});});
await wait(); const B=await p.screenshot({type:'png'});
const out=await p.evaluate(async ([a,bb])=>{
  const load=d=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+d;});
  const ia=await load(a),ib=await load(bb);
  const c=document.createElement('canvas');c.width=ia.width;c.height=ia.height;
  const g=c.getContext('2d',{willReadFrequently:true});
  g.drawImage(ia,0,0);const da=g.getImageData(0,0,c.width,c.height).data;
  g.clearRect(0,0,c.width,c.height);g.drawImage(ib,0,0);const db=g.getImageData(0,0,c.width,c.height).data;
  let n=0,sum=0;const ratios=[];
  for(let i=0;i<da.length;i+=4){const la=0.2126*da[i]+0.7152*da[i+1]+0.0722*da[i+2];
    const lb=0.2126*db[i]+0.7152*db[i+1]+0.0722*db[i+2];const d=lb-la;
    if(d>3){n++;sum+=d;ratios.push(la/Math.max(1,lb));}}
  ratios.sort((a,b)=>a-b);
  const q=f=>+(ratios[Math.floor(f*(ratios.length-1))]||0).toFixed(3);
  return {shadowedPx:n,pct:+(100*n/(c.width*c.height)).toFixed(2),meanDrop:+(sum/Math.max(1,n)).toFixed(1),
    ratio_p01:q(0.01),ratio_p10:q(0.10),ratio_p50:q(0.50),ratio_p90:q(0.90)};
},[A.toString('base64'),B.toString('base64')]);
writeFileSync('/home/piotr/looping_opus_5_test/shots/_tshad_on.png',A);
console.log(JSON.stringify(out));
await b.close();
