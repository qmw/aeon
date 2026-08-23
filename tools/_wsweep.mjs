// water agent scratch: attribute the sea's HF/MID to each term in ONE browser session.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const CFG = JSON.parse(process.argv[2] || '[[1,1,1,1,1,1,1,1]]');
const BOX = [[1150,200,110,160,'wA'],[1300,320,120,90,'open'],[990,300,120,90,'shallow'],[880,180,120,90,'farNE']];
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
const wait=async n=>{const f=await p.evaluate(()=>window.__frameCount||0);
  await p.waitForFunction(k=>(window.__frameCount||0)>=k,f+n,{timeout:1200000});};
await wait(14);
const stats = async (png) => p.evaluate(async ({url,BOX})=>{
  const img=new Image(); img.src=url; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
  const d=g.getImageData(0,0,c.width,c.height).data, W=c.width, H=c.height;
  const L=new Float32Array(W*H);
  for(let i=0,j=0;i<d.length;i+=4,j++) L[j]=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
  const box=(r,x,y)=>{let s=0,n=0;for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=W||yy>=H)continue;s+=L[yy*W+xx];n++;}return s/n;};
  return BOX.map(([X,Y,w,h,name])=>{let hf=0,mid=0,n=0,m=0;
    for(let y=Y;y<Y+h;y++)for(let x=X;x<X+w;x++){const l=L[y*W+x];hf+=(l-box(1,x,y))**2;mid+=(box(2,x,y)-box(8,x,y))**2;m+=l;n++;}
    const HF=Math.sqrt(hf/n),MID=Math.sqrt(mid/n);
    return {name,mean:+(m/n).toFixed(1),HF:+HF.toFixed(2),MID:+MID.toFixed(2),r:+(MID/HF).toFixed(2)};});
}, {url:'data:image/png;base64,'+png, BOX});
for (const c of CFG) {
  await p.evaluate(k=>{ const u=window.water.u; u.uK0.value.set(k[0],k[1],k[2],k[3]); u.uK1.value.set(k[4],k[5],k[6],k[7]); }, c);
  await wait(11);
  const png = (await p.screenshot({type:'png'})).toString('base64');
  console.log(JSON.stringify(c), JSON.stringify(await stats(png)));
}
await b.close();
