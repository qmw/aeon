import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b64 = readFileSync(process.argv[2]).toString('base64');
const pts = JSON.parse(process.argv[3]);
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p = await br.newPage();
const out = await p.evaluate(async ({url,pts})=>{
 const img=new Image(); img.src=url; await img.decode();
 const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const res=[];
 for(const P of pts){
  let r=0,gg=0,b=0,n=0, lmin=1e9,lmax=-1e9, hist=new Array(0);
  const vals=[];
  for(let y=P.y;y<P.y+P.h;y++)for(let x=P.x;x<P.x+P.w;x++){
   const o=(y*c.width+x)*4; r+=d[o];gg+=d[o+1];b+=d[o+2];n++;
   const l=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2]; vals.push(l);
  }
  r/=n;gg/=n;b/=n;
  vals.sort((a,b)=>a-b);
  const q=(f)=>vals[Math.floor(f*(vals.length-1))];
  const mx=Math.max(r,gg,b),mn=Math.min(r,gg,b);
  let hue=0; const dl=mx-mn;
  if(dl>0){ if(mx===r)hue=60*(((gg-b)/dl)%6); else if(mx===gg)hue=60*((b-r)/dl+2); else hue=60*((r-gg)/dl+4);}
  if(hue<0)hue+=360;
  res.push({name:P.name,rgb:[r,gg,b].map(v=>+v.toFixed(1)),hex:'#'+[r,gg,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''),hue:+hue.toFixed(1),sat:+(mx?dl/mx:0).toFixed(3),val:+(mx/255).toFixed(3),p1:+q(0.01).toFixed(1),p50:+q(0.5).toFixed(1),p99:+q(0.99).toFixed(1)});
 }
 return res;
},{url:'data:image/png;base64,'+b64,pts});
console.log(JSON.stringify(out,null,1));
await br.close();
