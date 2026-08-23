import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const f=process.argv[2];
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
const b64=readFileSync(f).toString('base64');
console.log(await p.evaluate(async (b64)=>{
  const i=await new Promise(r=>{const im=new Image();im.onload=()=>r(im);im.src='data:image/png;base64,'+b64;});
  const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);
  const d=g.getImageData(0,0,i.width,i.height).data; const out=[];
  for(let y=440;y<760;y+=3)for(let x=380;x<720;x+=3){
    const k=(y*i.width+x)*4;
    if(d[k]>=254&&out.length<24) out.push(`${x},${y}:${d[k]},${d[k+1]},${d[k+2]}`);
  }
  return out.join(' ');
},b64));
await br.close();
