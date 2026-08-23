// Mean |ΔL| between two shots inside named boxes. Answers "does this shader draw here at all".
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [,, a, b, ...boxes] = process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await br.newPage();
console.log(JSON.stringify(await p.evaluate(async ({ua,ub,boxes})=>{
  const load=async u=>{const i=new Image();i.src=u;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(i,0,0);return {d:g.getImageData(0,0,c.width,c.height).data,W:c.width};};
  const A=await load(ua), B=await load(ub);
  return boxes.map(s=>{const [r,name]=s.split(':');const [x,y,w,h]=r.split(',').map(Number);
    let sum=0,mx=0,n=0;
    for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++){const q=(j*A.W+i)*4;
      const la=0.2126*A.d[q]+0.7152*A.d[q+1]+0.0722*A.d[q+2];
      const lb=0.2126*B.d[q]+0.7152*B.d[q+1]+0.0722*B.d[q+2];
      const e=Math.abs(la-lb); sum+=e; if(e>mx)mx=e; n++;}
    return {name:name||r, meanAbsDelta:+(sum/n).toFixed(3), maxAbsDelta:+mx.toFixed(1)};});
},{ua:'data:image/png;base64,'+readFileSync(a).toString('base64'),ub:'data:image/png;base64,'+readFileSync(b).toString('base64'),boxes}),null,1));
await br.close();
