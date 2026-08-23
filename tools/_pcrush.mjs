// scratch(post): where are the crushed / blown / high-sat pixels? node tools/_pcrush.mjs shot.png
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
console.log(JSON.stringify(await p.evaluate(async url => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const BX = Math.ceil(c.width / 100), BY = Math.ceil(c.height / 100);
  const cr = new Int32Array(BX * BY), bl = new Int32Array(BX * BY);
  let hu = new Int32Array(12), hn = 0, satS = 0, satN = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const o = (y * c.width + x) * 4, R = d[o], G = d[o+1], B = d[o+2];
    const l = 0.2126*R + 0.7152*G + 0.0722*B, bi = ((y/100)|0) * BX + ((x/100)|0);
    if (l < 4) cr[bi]++; if (l > 250) bl[bi]++;
    const mx = Math.max(R,G,B), mn = Math.min(R,G,B), s = mx ? (mx-mn)/mx : 0;
    if (s > 0.18 && x < 1260) { let h; const dd = mx-mn;
      h = mx===R ? 60*(((G-B)/dd)%6) : mx===G ? 60*((B-R)/dd+2) : 60*((R-G)/dd+4);
      if (h < 0) h += 360; hu[(h/30)|0]++; hn++; satS += s; satN++; }
  }
  const top = a => [...a].map((v,i)=>[v,(i%BX)*100,((i/BX)|0)*100]).filter(t=>t[0]>60).sort((x,y)=>y[0]-x[0]).slice(0,8);
  return { crushBlocks: top(cr), blownBlocks: top(bl), hueHist: [...hu].map((v,i)=>[i*30, +(100*v/hn).toFixed(1)]), meanSat: +(satS/satN).toFixed(3) };
}, 'data:image/png;base64,' + readFileSync(file).toString('base64')), null, 1));
await b.close();
