// units agent scratch: coarse luminance grid over a region. node tools/_grid.mjs img x y w h [cell]
import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const [,,f,x,y,w,h,cell='8'] = process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
const b64=readFileSync(f).toString('base64');
console.log((await p.evaluate(async ([b64,x,y,w,h,c])=>{
  const i=await new Promise(r=>{const im=new Image();im.onload=()=>r(im);im.src='data:image/png;base64,'+b64;});
  const cv=document.createElement('canvas');cv.width=i.width;cv.height=i.height;const g=cv.getContext('2d',{willReadFrequently:true});g.drawImage(i,0,0);
  const d=g.getImageData(x,y,w,h).data; const out=[];
  for(let yy=0;yy<h;yy+=c){ let row='';
    for(let xx=0;xx<w;xx+=c){ let s=0,n=0;
      for(let j=0;j<c&&yy+j<h;j++)for(let k=0;k<c&&xx+k<w;k++){const o=((yy+j)*w+xx+k)*4;s+=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2];n++;}
      row+=String(Math.round(s/n)).padStart(4);}
    out.push(row);}
  return out.join('\n');
},[b64,+x,+y,+w,+h,+cell])));
await br.close();
