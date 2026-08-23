import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const f=process.argv[2]; const b64=readFileSync(f).toString('base64');
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
console.log(await p.evaluate(async b64=>{
  const i=new Image(); i.src='data:image/png;base64,'+b64; await i.decode();
  const c=document.createElement('canvas');c.width=i.width;c.height=i.height;
  const g=c.getContext('2d');g.drawImage(i,0,0);const d=g.getImageData(0,0,i.width,i.height).data;
  const cell=new Map();
  for(let y=46;y<i.height;y++)for(let x=0;x<1270;x++){
    if(y>670&&x<400)continue; if(y>570&&x>1290)continue;
    const k=(y*i.width+x)*4;
    if(d[k]>=254){const key=`${(x/100|0)*100},${(y/100|0)*100}`;cell.set(key,(cell.get(key)||0)+1);}
  }
  return [...cell.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(e=>e[0]+':'+e[1]).join(' ');
},b64));
await br.close();
