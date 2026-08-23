// Flat-top axial hex math. q = column, r = row. World plane: x/z, y = up.
export const HEX_SIZE = 1.0;
const SQRT3 = Math.sqrt(3);

export function axialToWorld(q, r, size = HEX_SIZE) {
  return { x: size * 1.5 * q, z: size * SQRT3 * (r + q / 2) };
}
export function worldToAxial(x, z, size = HEX_SIZE) {
  const q = (2 / 3) * x / size;
  const r = (-1 / 3) * x / size + (SQRT3 / 3) * z / size;
  return roundAxial(q, r);
}
export function roundAxial(q, r) {
  let s = -q - r;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}
export const DIRS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];
export function neighbor(q, r, dir) { const d = DIRS[dir % 6]; return { q: q + d.q, r: r + d.r }; }
export function neighbors(q, r) { return DIRS.map(d => ({ q: q + d.q, r: r + d.r })); }
export function hexDistance(aq, ar, bq, br) {
  const dq = aq - bq, dr = ar - br;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}
export function ring(cq, cr, radius) {
  if (radius === 0) return [{ q: cq, r: cr }];
  const out = []; let q = cq + DIRS[4].q * radius, r = cr + DIRS[4].r * radius;
  for (let i = 0; i < 6; i++) for (let j = 0; j < radius; j++) { out.push({ q, r }); q += DIRS[i].q; r += DIRS[i].r; }
  return out;
}
export function spiral(cq, cr, radius) {
  const out = []; for (let k = 0; k <= radius; k++) out.push(...ring(cq, cr, k)); return out;
}
// Corner offsets for a flat-top hex, CCW from +x.
export function corners(size = HEX_SIZE) {
  const c = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i; c.push([size * Math.cos(a), size * Math.sin(a)]); }
  return c;
}
