import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const regions = process.argv.slice(3).map(s=>{const[r,name]=s.split(':');const[x,y,w,h]=r.split(',').map(Number);return{x,y,w,h,name};});
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await b.newPage();
const url='data:image/png;base64,'+readFileSync(file).toString('base64');
const out=await p.evaluate(async({url,regions})=>{
 const img=new Image();img.src=url;await img.decode();
 const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
 const hsv=(r,gg,bb)=>{r/=255;gg/=255;bb/=255;const mx=Math.max(r,gg,bb),mn=Math.min(r,gg,bb),d=mx-mn;let h=0;
  if(d){if(mx===r)h=60*(((gg-bb)/d)%6);else if(mx===gg)h=60*((bb-r)/d+2);else h=60*((r-gg)/d+4);}
  if(h<0)h+=360;return[h,mx?d/mx:0,mx];};
 const hex=v=>Math.round(v).toString(16).padStart(2,'0');
 return regions.map(rg=>{const d=g.getImageData(rg.x,rg.y,rg.w,rg.h).data;
  let R=0,G=0,B=0,n=0;for(let i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];n++;}
  R/=n;G/=n;B/=n;const[h,s,v]=hsv(R,G,B);
  return {name:rg.name,hex:'#'+hex(R)+hex(G)+hex(B),hue:+h.toFixed(0),sat:+s.toFixed(3),val:+v.toFixed(3)};});
},{url,regions});
console.table(out);await b.close();
