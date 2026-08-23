// AEON — fog of war. The contract's fx.js: one input, `setVisibility(Uint8Array)` from turn.js,
// once per turn.
//
// Two sheets over the same hex lattice, both built from terrain.js's own welded corner heights so
// they ride the relief instead of hovering over it:
//
//  * DIM  — ground-hugging, over tiles the player has explored but cannot currently see. Keeps the
//           terrain readable and drains its light, which is what "remembered" has to look like.
//  * DECK — a cloud layer ~2.4 above the ground over tiles nobody has walked yet. It has to float:
//           at ground level the trees and cliffs of unexplored land poke straight through, and the
//           whole point of the layer is that you cannot see what is under it.
//
// Visibility is per TILE but shaded per VERTEX: every lattice corner averages the three tiles that
// share it, so the boundary is a soft ramp across half a hex rather than a staircase of hexagons.
// One float buffer upload per turn, two draw calls, no per-frame allocation.
import * as THREE from 'three';
import { DIRS, axialToWorld } from '../world/hex.js';

const PLATE = 2.05;      // terrain.js radial height exponent
// corner k of a flat-top hex is shared with these two neighbours (see grid.js EDGE_DIR)
const CORNER_NB = [];
for (let k = 0; k < 6; k++) CORNER_NB.push([[0, 5, 4, 3, 2, 1][(k + 5) % 6], [0, 5, 4, 3, 2, 1][k]]);

const VERT = /* glsl */`
attribute float aVis;              // 0 unexplored .. 2 visible, averaged at the corners
attribute float aLift;             // extra deck clearance where terrain.js stands summits up
uniform float uLift, uDeck;
varying float vV; varying vec2 vW; varying float vD;
void main() {
  vV = aVis;
  vec4 wp = modelMatrix * vec4(position.x, position.y + uLift + aLift * uDeck, position.z, 1.0);
  vW = wp.xz;
  vD = length(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// value noise, two octaves — enough for a torn edge and a bit of body in the deck
const NOISE = /* glsl */`
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ return vnoise(p) * 0.62 + vnoise(p * 2.17 + 3.1) * 0.26 + vnoise(p * 4.4 - 1.7) * 0.12; }`;

const FRAG = /* glsl */`
precision highp float;
${NOISE}
uniform float uTime, uDeck;
uniform vec3 uCol;
varying float vV; varying vec2 vW; varying float vD;
void main() {
  float n = fbm(vW * 0.21 + vec2(uTime * 0.012, uTime * 0.008));
  // the noise pushes the threshold either way, so the boundary tears instead of ramping evenly
  float v = vV + (n - 0.5) * 0.55 * uDeck;
  float a = uDeck > 0.5
    ? smoothstep(0.92, 0.16, v) * (0.82 + 0.18 * vnoise(vW * 0.62 - vec2(uTime * 0.03, 0.0)))
    : smoothstep(1.92, 1.02, v) * 0.46;
  if (a <= 0.004) discard;
  // the deck is lit from above: the noise doubles as its shading, so it reads as cloud volume
  vec3 c = uCol * (uDeck > 0.5 ? (0.72 + 0.85 * n * n) : 1.0);
  // aerial perspective on the deck itself, or the far edge of the world reads as a hard black wall
  a *= 1.0 - smoothstep(120.0, 260.0, vD) * 0.45 * uDeck;
  gl_FragColor = vec4(c * a, a);
}`;

export class FX {
  constructor(map, opts = {}) {
    this.map = map; this.terrain = opts.terrain ?? null;
    this.group = new THREE.Group(); this.group.name = 'fx';
    this.time = 0;

    const n = map.tiles.length;
    const pos = new Float32Array(n * 7 * 3), idx = new Uint32Array(n * 6 * 3);
    // The cloud deck has to clear whatever stands on the tile. Trees fit under a flat 2.35, but
    // terrain.js grows summit masses several units out of the massif, so the deck ramps with
    // height there. Capped: every unit of lift is a unit of parallax against the ground it hides.
    const lift = new Float32Array(n * 7);
    // per-layer index, refilled once per turn: ground the player is standing in has no fog on it
    // and must not cost a fragment. See setVisibility.
    this.iDim = new Uint32Array(n * 6 * 3); this.iDeck = new Uint32Array(n * 6 * 3);
    this.vis = new Float32Array(n * 7).fill(2);      // start fully lit: no black flash before turn 1
    const T = this.terrain;
    const y = (i, k, R) => {
      if (!T?.centreY) return Math.max(0.12, map.tiles[i].height);
      const yC = T.centreY[i], yO = T.cornerY[i * 6 + k];
      return Math.max(0.12, yC + (yO - yC) * Math.pow(R, PLATE));
    };
    for (const t of map.tiles) {
      const p = axialToWorld(t.q, t.r), b = t.i * 7, o = b * 3;
      const cy = y(t.i, 0, 0);
      pos[o] = p.x; pos[o + 1] = cy; pos[o + 2] = p.z;
      lift[b] = Math.min(3.4, Math.max(0, cy - 2.4) * 0.5);
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3, j = o + (k + 1) * 3;
        const yy = y(t.i, k, 1);
        pos[j] = p.x + Math.cos(a); pos[j + 1] = yy; pos[j + 2] = p.z + Math.sin(a);
        lift[b + 1 + k] = Math.min(3.4, Math.max(0, yy - 2.4) * 0.5);
        const e = (t.i * 6 + k) * 3;
        idx[e] = b; idx[e + 1] = b + 1 + k; idx[e + 2] = b + 1 + (k + 1) % 6;
      }
    }
    this.tri = idx;
    const posAttr = new THREE.BufferAttribute(pos, 3), liftAttr = new THREE.BufferAttribute(lift, 1);
    this.attr = new THREE.BufferAttribute(this.vis, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    // one lattice, two index views into it — the attributes are shared buffer objects, so the
    // second layer costs an index and nothing else
    const geom = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', posAttr); g.setAttribute('aVis', this.attr); g.setAttribute('aLift', liftAttr);
      const ix = new THREE.BufferAttribute(new Uint32Array(idx.length), 1);
      ix.setUsage(THREE.DynamicDrawUsage);
      g.setIndex(ix); g.setDrawRange(0, 0);
      g.computeBoundingSphere();
      return g;
    };
    this.gDim = geom(); this.gDeck = geom();

    this.uTime = { value: 0 };
    const sheet = (g, lift, deck, col, order) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: this.uTime, uLift: { value: lift }, uDeck: { value: deck }, uCol: { value: new THREE.Color(col) } },
        vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = order; mesh.frustumCulled = false;
      this.group.add(mesh); return mesh;
    };
    // 0.06 clears the grid decal's own bias; 2.35 clears the tallest tree terrain.js plants
    this.dim = sheet(this.gDim, 0.06, 0, 0x0a1018, 20);
    this.deck = sheet(this.gDeck, 2.35, 1, 0x161b26, 21);
  }

  // vis: 0 hidden, 1 explored-but-fogged, 2 visible — the array turn.js keeps for civ 0
  setVisibility(v) {
    if (!v) return;
    const { map } = this, V = this.vis, D = this.iDim, K = this.iDeck, T = this.tri;
    let nd = 0, nk = 0;
    for (const t of map.tiles) {
      const c = v[t.i], b = t.i * 7;
      V[b] = c;
      let lo = c;
      for (let k = 0; k < 6; k++) {
        let s = c, n = 1;
        for (const d of CORNER_NB[k]) {
          const u = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
          s += u ? v[u.i] : 0; n++;                  // off-map corners pull dark: the world ends in cloud
        }
        const a = s / n; V[b + 1 + k] = a; if (a < lo) lo = a;
      }
      // Nothing to draw over ground that is fully in sight, and the cloud deck only exists where
      // the noise can still push a corner under its threshold. At gameplay zoom this is what keeps
      // two full-map transparent sheets off the fill budget.
      const o = t.i * 18;
      if (lo < 1.95) { for (let k = 0; k < 18; k++) D[nd++] = T[o + k]; }
      if (lo < 1.25) { for (let k = 0; k < 18; k++) K[nk++] = T[o + k]; }
    }
    this.attr.needsUpdate = true;
    for (const [g, src, count] of [[this.gDim, D, nd], [this.gDeck, K, nk]]) {
      g.index.array.set(src.subarray(0, count));
      g.index.needsUpdate = true; g.setDrawRange(0, count);
    }
  }

  update(dt) { this.uTime.value = this.time += dt; }

  dispose() { this.gDim.dispose(); this.gDeck.dispose(); this.dim.material.dispose(); this.deck.material.dispose(); }
}
export default FX;
