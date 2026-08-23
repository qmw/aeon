import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file=process.argv[2]; const pts=process.argv.slice(3).map(s=>s.split(',').map(Number));
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const R=await p.evaluate(async({u,pts})=>{
 const img=new Image();img.src=u;await img.decode();
 const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const hueOf=(r,g2,b2)=>{const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2),df=M-m;if(df<1e-6)return -1;
  let h=M===r?60*(((g2-b2)/df)%6):M===g2?60*((b2-r)/df+2):60*((r-g2)/df+4);if(h<0)h+=360;return h;};
 return pts.map(([x,y,w=7])=>{let r=0,g2=0,b2=0,n=0;
  for(let j=y-w;j<=y+w;j++)for(let i=x-w;i<=x+w;i++){const o=(j*c.width+i)*4;r+=d[o];g2+=d[o+1];b2+=d[o+2];n++;}
  r=Math.round(r/n);g2=Math.round(g2/n);b2=Math.round(b2/n);
  const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2);
  return {at:[x,y],rgb:[r,g2,b2],hex:'#'+[r,g2,b2].map(v=>v.toString(16).padStart(2,'0')).join(''),
   hue:+hueOf(r/255,g2/255,b2/255).toFixed(1),sat:+((M-m)/(M||1)).toFixed(3),L:+((0.2126*r+0.7152*g2+0.0722*b2)/255).toFixed(3)};});
},{u:'data:image/png;base64,'+readFileSync(file).toString('base64'),pts});
console.log(JSON.stringify(R));
await b.close();
