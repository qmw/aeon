import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:700,height:400}});
const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
p.on('console',m=>{if(m.type()==='error'&&!/favicon|Failed to load/.test(m.text()))errors.push(m.text());});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
await p.waitForTimeout(8000);
const r = await p.evaluate(()=>{
  const U=window.units, out={};
  const ids=[...U.units.keys()];
  // moveUnit with both shapes
  const u=U.units.get(ids[0]);
  U.moveUnit(ids[0], [[u.q,u.r],[u.q+1,u.r],[u.q+1,u.r-1]]);
  out.pathSet = !!U.units.get(ids[0]).path;
  for(let i=0;i<40;i++) U.update(0.05);
  out.moved = true;
  // remove a unit and a city, then re-add
  out.rmUnit = U.remove(ids[1]);
  out.rmCity = U.remove(U.cities[U.cities.length-1].id);
  for(let i=0;i<5;i++) U.update(0.05);
  out.newId = U.add({type:'trireme', q:u.q, r:u.r, team:2});
  out.newCity = U.add({type:'city', q:u.q+3, r:u.r+3, team:2, pop:8, prod:4, districts:[{dir:1,kind:'farm'}]});
  for(let i=0;i<5;i++) U.update(0.05);
  out.counts={units:U.units.size, cities:U.cities.length, builds:[...U.builds.keys()].length};
  return out;
});
console.log(JSON.stringify(r)); console.log('errors', errors.slice(0,8));
await b.close();
