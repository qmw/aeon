// where are the crushed pixels? node tools/_crush2.mjs img.png [thresh]
import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const [,,f,th='4']=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
console.log(await p.evaluate(async ([b64,th])=>{
  const i=await new Promise(r=>{const im=new Image();im.onload=()=>r(im);im.src='data:image/png;base64,'+b64;});
  const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);
  const d=g.getImageData(0,0,c.width,c.height).data;
  const BX=Math.ceil(c.width/12), BY=Math.ceil(c.height/8), grid=[];
  for(let by=0;by<8;by++){ let row='';
    for(let bx=0;bx<12;bx++){ let n=0,tot=0;
      for(let y=by*BY;y<Math.min(c.height,(by+1)*BY);y++) for(let x=bx*BX;x<Math.min(c.width,(bx+1)*BX);x++){
        const o=(y*c.width+x)*4, l=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2]; tot++; if(l<th)n++; }
      const pc=100*n/tot; row += (pc<0.05?'  .':pc.toFixed(1).padStart(3))+' '; }
    grid.push(row); }
  return grid.join('\n');
},[readFileSync(f).toString('base64'),+th]));
await br.close();
