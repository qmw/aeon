// Objective image metrics for a screenshot, so agents can iterate without guessing.
// Usage: node tools/metrics.mjs shots/x.png [x,y,w,h[:name]] ...   (default: 6 sample regions)
// Reports per region: mean luminance, saturation, HF_rms (pixel-scale detail), MID_rms (blob energy),
// MID/HF ratio (a shipping AAA ground shader lands <= 1.2), plus global clipping percentages.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const file = resolve(process.argv[2] || 'shots/final-hero.png');
const regions = process.argv.slice(3).map(s => { const [r, name] = s.split(':'); const [x, y, w, h] = r.split(',').map(Number); return { x, y, w, h, name: name || `${x},${y}` }; });
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
const out = await p.evaluate(async ({ url, regions }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const full = g.getImageData(0, 0, c.width, c.height).data;
  const lum = new Float32Array(c.width * c.height);
  for (let i = 0, j = 0; i < full.length; i += 4, j++) lum[j] = 0.2126 * full[i] + 0.7152 * full[i + 1] + 0.0722 * full[i + 2];
  const box = (r, x, y, W, H) => { let s = 0, n = 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; s += lum[yy * W + xx]; n++; } return s / n; };
  const stats = [];
  const defs = regions.length ? regions : [
    { x: 60, y: 120, w: 240, h: 160, name: 'upper-left' }, { x: 380, y: 380, w: 240, h: 160, name: 'mid-left' },
    { x: 700, y: 700, w: 240, h: 160, name: 'near-field' }, { x: 1000, y: 200, w: 240, h: 160, name: 'water' },
    { x: 640, y: 430, w: 200, h: 140, name: 'center' }, { x: 200, y: 700, w: 240, h: 160, name: 'near-left' },
  ];
  for (const R of defs) {
    let hf = 0, mid = 0, n = 0, L = 0, S = 0;
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
      if (x < 1 || y < 1 || x >= c.width - 1 || y >= c.height - 1) continue;
      const i = y * c.width + x, l = lum[i];
      hf += Math.pow(l - box(1, x, y, c.width, c.height), 2);
      mid += Math.pow(box(2, x, y, c.width, c.height) - box(8, x, y, c.width, c.height), 2);
      const o = i * 4, mx = Math.max(full[o], full[o + 1], full[o + 2]), mn = Math.min(full[o], full[o + 1], full[o + 2]);
      S += mx ? (mx - mn) / mx : 0; L += l; n++;
    }
    const HF = Math.sqrt(hf / n), MID = Math.sqrt(mid / n);
    stats.push({ name: R.name, mean: +(L / n).toFixed(1), sat: +(S / n).toFixed(3), HF_rms: +HF.toFixed(2), MID_rms: +MID.toFixed(2), MID_over_HF: +(MID / (HF || 1e-6)).toFixed(2) });
  }
  let crushed = 0, blown = 0;
  for (let i = 0; i < lum.length; i++) { if (lum[i] < 4) crushed++; if (lum[i] > 250) blown++; }
  return { size: [c.width, c.height], crushedPct: +(100 * crushed / lum.length).toFixed(2), blownPct: +(100 * blown / lum.length).toFixed(2), regions: stats };
}, { url: 'data:image/png;base64,' + readFileSync(file).toString('base64'), regions });
// Two-sided gate. HF alone is gameable: spraying per-pixel noise raises it while destroying
// material structure, so MID/HF is bounded on BOTH sides and detail must fall off with distance.
const BANDS = { HF: [12, 22], MID_over_HF: [0.9, 1.3], sat: [0.28, 0.46] };
const fails = [];
for (const r of out.regions) {
  const isWater = /water|sea|ocean/i.test(r.name);
  const hf = isWater ? [7, 15] : BANDS.HF;
  if (r.HF_rms < hf[0]) fails.push(`${r.name}: HF_rms ${r.HF_rms} < ${hf[0]} (no material detail)`);
  if (r.HF_rms > hf[1]) fails.push(`${r.name}: HF_rms ${r.HF_rms} > ${hf[1]} (pixel noise / confetti)`);
  if (r.MID_over_HF < BANDS.MID_over_HF[0]) fails.push(`${r.name}: MID/HF ${r.MID_over_HF} < ${BANDS.MID_over_HF[0]} (noise dominates structure)`);
  if (r.MID_over_HF > BANDS.MID_over_HF[1]) fails.push(`${r.name}: MID/HF ${r.MID_over_HF} > ${BANDS.MID_over_HF[1]} (blurry blobs, no material)`);
  if (!isWater && (r.sat < BANDS.sat[0] || r.sat > BANDS.sat[1])) fails.push(`${r.name}: saturation ${r.sat} outside ${BANDS.sat.join('-')}`);
}
if (out.crushedPct > 0.30) fails.push(`crushedPct ${out.crushedPct} > 0.30`);
if (out.blownPct > 0.05) fails.push(`blownPct ${out.blownPct} > 0.05`);
// Detail must shrink with distance: a real mipped material falls ~3:1 from near to far.
const near = out.regions.find(r => /near/i.test(r.name)), far = out.regions.find(r => /far|upper/i.test(r.name));
if (near && far) {
  const ramp = +(near.HF_rms / (far.HF_rms || 1e-6)).toFixed(2);
  out.nearFarHFRamp = ramp;
  if (ramp < 1.6) fails.push(`near/far HF ramp ${ramp} < 1.6 (detail does not shrink with distance — screen-space noise, not world-space material)`);
}
out.gate = fails.length ? 'FAIL' : 'PASS';
out.failures = fails;
console.log(JSON.stringify(out, null, 1));
await b.close();
