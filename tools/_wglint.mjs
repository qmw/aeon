import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const [,,f,...specs]=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
const b64=readFileSync(f).toString('base64');
console.log(JSON.stringify(await p.evaluate(async ([b64,specs])=>{
 const i=await new Promise(r=>{const im=new Image();im.onload=()=>r(im);im.src='data:image/png;base64,'+b64;});
 const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(i,0,0);
 return specs.map(s=>{const[r,name]=s.split(':');const[x,y,w,h]=r.split(',').map(Number);
  const d=g.getImageData(x,y,w,h).data;const px=[];
  for(let k=0;k<d.length;k+=4)px.push([d[k],d[k+1],d[k+2],0.2126*d[k]+0.7152*d[k+1]+0.0722*d[k+2]]);
  px.sort((a,b)=>a[3]-b[3]);const n=px.length;
  const q=t=>px[Math.min(n-1,Math.floor(t*n))];
  const mean=px.reduce((a,b)=>a+b[3],0)/n;
  const top=q(0.99),hi=px[n-1],lo=q(0.01);
  return{name,mean:+mean.toFixed(1),p1:+lo[3].toFixed(0),p99:+top[3].toFixed(0),max:+hi[3].toFixed(0),
   p99rgb:top.slice(0,3),maxrgb:hi.slice(0,3),warmth:+(hi[0]-hi[2]),contrast:+((top[3]-lo[3])).toFixed(0)};});
},[b64,specs]),null,1));
await br.close();
