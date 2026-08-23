// octave energy + directional anisotropy of a patch
import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const [,,f,...specs]=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
const b64=readFileSync(f).toString('base64');
console.log(JSON.stringify(await p.evaluate(async ([b64,specs])=>{
 const i=await new Promise(r=>{const im=new Image();im.onload=()=>r(im);im.src='data:image/png;base64,'+b64;});
 const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(i,0,0);
 const out=[];
 for(const s of specs){ const [r,name]=s.split(':'); const [x,y,w,h]=r.split(',').map(Number);
  const d=g.getImageData(x,y,w,h).data; let L=[]; for(let k=0;k<d.length;k+=4) L.push(0.2126*d[k]+0.7152*d[k+1]+0.0722*d[k+2]);
  // octave energy: box-downsample by 1,2,4,8 and measure residual rms at each level
  const oct=[]; let cur=L, W=w, H=h;
  for(let lv=0; lv<4; lv++){
    // blur 3x3, residual rms
    let res=0,n=0;
    for(let yy=1;yy<H-1;yy++)for(let xx=1;xx<W-1;xx++){let s=0;for(let a=-1;a<2;a++)for(let b=-1;b<2;b++)s+=cur[(yy+a)*W+xx+b];const e=cur[yy*W+xx]-s/9;res+=e*e;n++;}
    oct.push(+Math.sqrt(res/n).toFixed(2));
    const nW=W>>1,nH=H>>1,nx=new Float32Array(nW*nH);
    for(let yy=0;yy<nH;yy++)for(let xx=0;xx<nW;xx++)nx[yy*nW+xx]=(cur[2*yy*W+2*xx]+cur[2*yy*W+2*xx+1]+cur[(2*yy+1)*W+2*xx]+cur[(2*yy+1)*W+2*xx+1])/4;
    cur=nx;W=nW;H=nH;
  }
  // anisotropy: rms of horizontal vs vertical first difference at 1:1
  let dh=0,dv=0,n2=0;
  for(let yy=1;yy<h-1;yy++)for(let xx=1;xx<w-1;xx++){const a=L[yy*w+xx];dh+=(a-L[yy*w+xx-1])**2;dv+=(a-L[(yy-1)*w+xx])**2;n2++;}
  out.push({name,octaveRMS:oct,octRatio:+(oct[0]/oct[3]).toFixed(2),dH:+Math.sqrt(dh/n2).toFixed(2),dV:+Math.sqrt(dv/n2).toFixed(2),aniso:+(Math.sqrt(dh/n2)/Math.sqrt(dv/n2)).toFixed(2)});
 }
 return out;
},[b64,specs]),null,1));
await br.close();
