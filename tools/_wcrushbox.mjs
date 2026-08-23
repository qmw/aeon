import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [,, f, ...boxes] = process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await br.newPage();
console.log(JSON.stringify(await p.evaluate(async ({u,boxes})=>{
  const i=new Image(); i.src=u; await i.decode();
  const c=document.createElement('canvas');c.width=i.width;c.height=i.height;
  const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(i,0,0);
  const d=g.getImageData(0,0,c.width,c.height).data,W=c.width,H=c.height;
  const L=(q)=>0.2126*d[q]+0.7152*d[q+1]+0.0722*d[q+2];
  let tot=0; for(let q=0;q<d.length;q+=4) if(L(q)<4) tot++;
  const out={imageCrushedPx: tot, imagePct:+(100*tot/(W*H)).toFixed(3), boxes:{}};
  for(const s of boxes){const [r,name]=s.split(':');const [x,y,w,h]=r.split(',').map(Number);
    let n=0; for(let j=y;j<y+h;j++)for(let k=x;k<x+w;k++) if(L((j*W+k)*4)<4) n++;
    out.boxes[name||r]=n;}
  return out;
},{u:'data:image/png;base64,'+readFileSync(f).toString('base64'),boxes}),null,1));
await br.close();
