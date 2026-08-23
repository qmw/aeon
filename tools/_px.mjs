// mean RGB of a rect: node tools/_px.mjs img.png x y w h
import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const [,,f,x,y,w,h]=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
const b64=readFileSync(f).toString('base64');
console.log(JSON.stringify(await p.evaluate(async ([b64,x,y,w,h])=>{
  const i=await new Promise(r=>{const im=new Image();im.onload=()=>r(im);im.src='data:image/png;base64,'+b64;});
  const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);
  const d=g.getImageData(x,y,w,h).data; let R=0,G=0,B=0,n=0, mx=0, best=[0,0,0];
  for(let k=0;k<d.length;k+=4){R+=d[k];G+=d[k+1];B+=d[k+2];n++; const s=d[k+2]-d[k]; if(s>mx){mx=s;best=[d[k],d[k+1],d[k+2]];}}
  return {mean:[R/n|0,G/n|0,B/n|0], bluest:best};
},[b64,+x,+y,+w,+h])));
await br.close();
