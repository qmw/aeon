// Visualise which shapes carry the MID (box2-box8) and HF (px - box1) energy in a region.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, file, spec, outMid, outHf, gain='6'] = process.argv;
const [x,y,w,h] = spec.split(',').map(Number);
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const r = await p.evaluate(async ({url,x,y,w,h,g})=>{
  const img=new Image(); img.src=url; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const ctx=c.getContext('2d',{willReadFrequently:true}); ctx.drawImage(img,0,0);
  const d=ctx.getImageData(0,0,c.width,c.height).data, W=c.width,H=c.height;
  const lum=new Float32Array(W*H);
  for(let i=0,j=0;i<d.length;i+=4,j++) lum[j]=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
  const box=(r,X,Y)=>{let s=0,n=0;for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){const xx=X+dx,yy=Y+dy;if(xx<0||yy<0||xx>=W||yy>=H)continue;s+=lum[yy*W+xx];n++;}return s/n;};
  const mk=(fn)=>{const cc=document.createElement('canvas');cc.width=w;cc.height=h;const g2=cc.getContext('2d');const im=g2.createImageData(w,h);
    for(let j=0;j<h;j++)for(let i=0;i<w;i++){const v=128+fn(x+i,y+j)*g;const q=(j*w+i)*4;im.data[q]=im.data[q+1]=im.data[q+2]=Math.max(0,Math.min(255,v));im.data[q+3]=255;}
    g2.putImageData(im,0,0);
    const c3=document.createElement('canvas'); c3.width=w*3;c3.height=h*3;const g3=c3.getContext('2d');g3.imageSmoothingEnabled=false;g3.drawImage(cc,0,0,w*3,h*3);
    return c3.toDataURL('image/png');};
  return { mid: mk((X,Y)=>box(2,X,Y)-box(8,X,Y)), hf: mk((X,Y)=>lum[Y*W+X]-box(1,X,Y)) };
}, {url:'data:image/png;base64,'+readFileSync(file).toString('base64'),x,y,w,h,g:+gain});
writeFileSync(outMid, Buffer.from(r.mid.split(',')[1],'base64'));
writeFileSync(outHf, Buffer.from(r.hf.split(',')[1],'base64'));
await b.close();
