import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const R=await p.evaluate(async({u})=>{
 const img=new Image();img.src=u;await img.decode();
 const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const hueOf=(r,g2,b2)=>{const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2),df=M-m;if(df<1e-6)return -1;
  let h=M===r?60*(((g2-b2)/df)%6):M===g2?60*((b2-r)/df+2):60*((r-g2)/df+4);if(h<0)h+=360;return h;};
 const s=[];let mgMax=0,sMax=0;
 for(let y=60;y<820;y++)for(let x=0;x<1260;x++){const o=(y*c.width+x)*4;
  const r=d[o]/255,g2=d[o+1]/255,b2=d[o+2]/255;const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2);
  if(M-m<0.03)continue;const h=hueOf(r,g2,b2);
  if(h>250&&h<340){const mg=Math.min(r,b2)-g2;mgMax=Math.max(mgMax,mg);sMax=Math.max(sMax,(M-m)/M);
   if(s.length<14&&Math.random()<0.02)s.push({at:[x,y],rgb:[d[o],d[o+1],d[o+2]],hue:+h.toFixed(0),sat:+((M-m)/M).toFixed(3),mg:+mg.toFixed(3)});}}
 return {samples:s,mgMax:+mgMax.toFixed(3),satMax:+sMax.toFixed(3)};
},{u:'data:image/png;base64,'+readFileSync('shots/final-hero.png').toString('base64')});
console.log(JSON.stringify(R,null,1));
await b.close();
