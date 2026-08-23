// grid on/off diff: how much does grid.group actually change the frame?
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const W=+(process.env.W||800), H=+(process.env.H||450);
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
const F = +(process.env.F||12);
await p.waitForFunction(n => (window.__frameCount||0) >= n, F, { timeout: 300000 }).catch(()=>{});
const shot = async () => (await p.screenshot({timeout:180000})).toString('base64');
const a = await shot();
await p.evaluate(() => { window.input.grid.group.visible = false; window.post._frame = 0; window.__frameCount = 0; });
await p.waitForFunction(n => (window.__frameCount||0) >= n, F, { timeout: 300000 }).catch(()=>{});
const c = await shot();
console.log(JSON.stringify(await p.evaluate(async ({a,c}) => {
  const load = async s => { const i = new Image(); i.src = 'data:image/png;base64,'+s; await i.decode();
    const cv = document.createElement('canvas'); cv.width=i.width; cv.height=i.height;
    const g = cv.getContext('2d',{willReadFrequently:true}); g.drawImage(i,0,0); return {d:g.getImageData(0,0,i.width,i.height).data,w:i.width,h:i.height}; };
  const A = await load(a), C = await load(c);
  let n=0, big=0, sum=0, mx=0; const map=new Array(16*9).fill(0);
  for (let y=0;y<A.h;y++) for (let x=0;x<A.w;x++) {
    const i=(y*A.w+x)*4;
    const la=0.2126*A.d[i]+0.7152*A.d[i+1]+0.0722*A.d[i+2];
    const lc=0.2126*C.d[i]+0.7152*C.d[i+1]+0.0722*C.d[i+2];
    const dv=Math.abs(la-lc); sum+=dv; n++; if(dv>6){big++; map[((y*9/A.h)|0)*16+((x*16/A.w)|0)]++;} if(dv>mx)mx=dv;
  }
  return { meanAbsDelta:+(sum/n).toFixed(2), pctOver6:+(100*big/n).toFixed(2), maxDelta:+mx.toFixed(0), map };
}, {a,c})));
await b.close();
