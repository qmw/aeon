import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [,,inp,...rs]=process.argv;
const b64=readFileSync(inp).toString('base64');
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await br.newPage();
const regions=rs.map(s=>{const[r,name]=s.split(':');const[x,y,w,h]=r.split(',').map(Number);return{x,y,w,h,name};});
const out=await p.evaluate(async ({b64,regions})=>{
 const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();
 const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const hsv=(r,gq,b)=>{r/=255;gq/=255;b/=255;const M=Math.max(r,gq,b),m=Math.min(r,gq,b),dl=M-m;let h=0;if(dl>0)h=M===r?60*(((gq-b)/dl)%6):M===gq?60*((b-r)/dl+2):60*((r-gq)/dl+4);if(h<0)h+=360;return[h,M?dl/M:0,M];};
 const res=[];
 for(const R of regions){
  const px=[];
  for(let y=R.y;y<R.y+R.h;y++)for(let x=R.x;x<R.x+R.w;x++){const o=(y*c.width+x)*4;const L=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2];px.push([L,d[o],d[o+1],d[o+2]]);}
  px.sort((a,b)=>a[0]-b[0]);
  const q=Math.floor(px.length*0.2);
  const agg=arr=>{let hx=0,hy=0,s=0,v=0,n=0;for(const[L,r,gq,b] of arr){const[h,sa,va]=hsv(r,gq,b);hx+=Math.cos(h*Math.PI/180);hy+=Math.sin(h*Math.PI/180);s+=sa;v+=va;n++;}let h=Math.atan2(hy/n,hx/n)*180/Math.PI;if(h<0)h+=360;return{hue:+h.toFixed(1),sat:+(s/n).toFixed(3),val:+(v/n*255).toFixed(1)};};
  const dark=agg(px.slice(0,q)),lit=agg(px.slice(-q));
  let dh=Math.abs(lit.hue-dark.hue);if(dh>180)dh=360-dh;
  res.push({name:R.name,lit,shadow:dark,hueDelta:+dh.toFixed(1),ratio:+(dark.val/lit.val).toFixed(2)});
 }
 return res;
},{b64,regions});
console.log(JSON.stringify(out,null,1));
await br.close();
