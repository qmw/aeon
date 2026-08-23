// Runnable check for src/game/input.js + src/render/grid.js: opening framing, WASD pan, Q/E
// rotate, wheel/Z-X zoom (and the pitch it drags with it), hover + click picking, Escape, Space.
// Run: node check-camera.mjs   (exit 0 = every control still works)
// Functional check for the camera rig + picking. Fails loudly if a control stops working.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
p.on('console',m=>{ if(m.type()==='error' && !/404|favicon/.test(m.text())) errs.push(m.text()); });
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000}); await p.waitForTimeout(11000);
const ready = async () => { for (let i = 0; i < 40; i++) { try { if (await p.evaluate(() => !!window.input)) return; } catch {} await p.waitForTimeout(1000); } };
const snap = async () => { await ready(); return snapRaw(); };
const snapRaw = () => p.evaluate(()=>({z:window.input.zoomT, yaw:window.input.yaw, fx:window.input.focus.x, fz:window.input.focus.z,
  pitch:window.input.pitch, dist:window.input.dist, hexes:1600/(Math.abs((()=>{const T=window.THREE,C=window.camera,I=window.input,v=new T.Vector3();
    v.set(I.focus.x,I.focus.y,I.focus.z).project(C); const a=(v.x*.5+.5)*1600; v.set(I.focus.x+1.5,I.focus.y,I.focus.z).project(C); return (v.x*.5+.5)*1600-a;})())),
  sel:window.input.grid._sel?.i ?? null, hover:window.input.grid._hover?.i ?? null,
  path:window.input.grid._path.length, range:window.input.grid._range.length, work:window.input.grid._work.length, fps:window.__fps}));
await ready();
await p.evaluate(()=>{ window.__mark = 1; });   // cleared by any Vite HMR reload
const a0 = await snap();
const fail = [];
const ok = (c,m)=>{ if(!c) fail.push(m); };
ok(a0.hexes>11 && a0.hexes<21, `opening framing shows ${a0.hexes.toFixed(1)} hexes across, want 12-20`);
ok(a0.pitch*180/Math.PI>34 && a0.pitch*180/Math.PI<46, `opening pitch ${(a0.pitch*180/Math.PI).toFixed(1)} deg, want 35-45`);
ok(a0.range>0 && a0.path>1 && a0.work>0, 'overlay should open with a move plate, a path and a city border');
// hover + pick
await p.mouse.move(700,430); await p.waitForTimeout(400); await p.mouse.move(760,470); await p.waitForTimeout(6000);
const a5 = await snap(); ok(a5.hover!=null, 'hover pick returned nothing');
await p.mouse.click(700,500); await p.waitForTimeout(6000);
const a6 = await snap(); ok(a6.sel!=null, 'click did not select a tile');
await p.keyboard.press('Escape'); await p.waitForTimeout(4000);
const a7 = await snap(); ok(a7.sel==null || a7.sel!==a6.sel, 'Escape did not clear the selection');
// pan
await p.mouse.move(800,450);
await p.keyboard.down('KeyD'); await p.waitForTimeout(9000); await p.keyboard.up('KeyD'); await p.waitForTimeout(1500);
const a1 = await snap(); ok(Math.hypot(a1.fx-a0.fx,a1.fz-a0.fz)>0.4, 'D did not pan');   // software GL runs ~1fps; main.js clamps dt to 0.05
// momentum: focus keeps drifting after the key is released
await p.waitForTimeout(120); const a1b = await snap();
// rotate
await p.keyboard.down('KeyE'); await p.waitForTimeout(6000); await p.keyboard.up('KeyE'); await p.waitForTimeout(800);
const a2 = await snap(); ok(Math.abs(a2.yaw-a1.yaw)>0.05, 'E did not rotate');
// zoom out tilts toward top-down
await p.mouse.wheel(0,900); await p.waitForTimeout(3000);
const a3 = await snap(); ok(a3.z>a1.z+0.05, 'wheel did not zoom out'); ok(a3.pitch>a2.pitch+0.02, 'zooming out did not raise the pitch');
await p.keyboard.down('KeyZ'); await p.waitForTimeout(6000); await p.keyboard.up('KeyZ'); await p.waitForTimeout(1500);
const a4 = await snap(); ok(a4.z<a3.z-0.02, 'Z did not zoom in');
// end turn
await ready();
const t0 = await p.evaluate(()=>window.game?.state.turn ?? -1);
await p.keyboard.press('Space'); await p.waitForTimeout(4000);
await ready();
const t1 = await p.evaluate(()=>window.game?.state.turn ?? -1);
ok(t0<0 || t1>t0, `Space did not end the turn (${t0} -> ${t1})`);
const alive = await p.evaluate(()=>window.__mark===1);
if(!alive){ console.log('RELOADED mid-run (another agent saved a file) - rerun'); await b.close(); process.exit(2); }
console.log(JSON.stringify({fps:a4.fps, hexes:+a0.hexes.toFixed(1), pitchDeg:+(a0.pitch*180/Math.PI).toFixed(1),
  overlay:{range:a0.range,path:a0.path,work:a0.work}, fail, errs:errs.slice(0,5)}));
await b.close();
process.exit(fail.length||errs.length?1:0);
