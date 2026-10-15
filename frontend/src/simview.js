// 3D playback of a fire simulation on top of the site viewer: people, flames and a smoke
// layer that comes down from the ceiling as it thickens.
import * as THREE from 'three';
import { smokeAt, STATE } from './sim.js';

export const PEOPLE_COLORS = { waiting: '#8a94a0', moving: '#2f6fe0', overcome: '#d64545', trapped: '#c98a1a' };
const STATE_COLOR = {
  [STATE.WAITING]: new THREE.Color(PEOPLE_COLORS.waiting),
  [STATE.MOVING]: new THREE.Color(PEOPLE_COLORS.moving),
  [STATE.OVERCOME]: new THREE.Color(PEOPLE_COLORS.overcome),
  [STATE.TRAPPED]: new THREE.Color(PEOPLE_COLORS.trapped),
};

export class SimLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    viewer.scene.add(this.group);
    this.result = null;
    this.t = 0;
  }

  clear() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    this.result = null;
  }

  show(result, site) {
    this.clear();
    this.result = result;
    const g = site.grid, c = g.cell_m, w = g.w, h = g.h;
    this.c = c; this.w = w; this.h = h;
    const N = result.people.length;

    // people: a body and a head, coloured by what they are doing
    const body = new THREE.CylinderGeometry(0.2, 0.22, 1.35, 10);
    body.translate(0, 0.675, 0);
    const head = new THREE.SphereGeometry(0.14, 10, 8);
    head.translate(0, 1.55, 0);
    const geo = mergeGeometries(body, head);
    this.people = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), Math.max(1, N));
    this.people.count = N;
    this.people.castShadow = true;
    this.people.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, N) * 3), 3);
    this.group.add(this.people);

    // fire and smoke on blocks of about half a metre (coarser for big sites)
    const bs = Math.max(1, Math.round(Math.max(0.5, Math.sqrt((w * h * c * c) / 20000)) / c));
    this.bs = bs;
    const bw = Math.ceil(w / bs), bh = Math.ceil(h / bs);
    const kind = new Uint8Array(w * h);
    g.cells.forEach((row, y) => { for (let x = 0; x < w; x++) kind[y * w + x] = row[x] === '.' || row[x] === 'D' || row[x] === 'E' ? 1 : 0; });
    // one sample cell per block: the walkable cell nearest the block's middle
    this.blocks = [];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let best = -1, bd = Infinity;
      for (let y = by * bs; y < Math.min(h, (by + 1) * bs); y++) for (let x = bx * bs; x < Math.min(w, (bx + 1) * bs); x++) {
        if (!kind[y * w + x]) continue;
        const d = (x - (bx + 0.5) * bs) ** 2 + (y - (by + 0.5) * bs) ** 2;
        if (d < bd) { bd = d; best = y * w + x; }
      }
      if (best >= 0) this.blocks.push({ i: best, x: (bx * bs + Math.min(bs, w - bx * bs) / 2) * c, y: (by * bs + Math.min(bs, h - by * bs) / 2) * c, sx: Math.min(bs, w - bx * bs) * c, sy: Math.min(bs, h - by * bs) * c, seed: Math.random() * 6.28 });
    }
    const nb = this.blocks.length;
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.flames = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: '#ff7a1a', emissive: '#ff5a00', emissiveIntensity: 1.2, transparent: true, opacity: 0.85 }), nb);
    this.flames.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nb * 3), 3);
    // smoke: one flat sheet per block at the bottom of the smoke layer (side faces would
    // double up where blocks meet and draw a grid)
    const sheet = new THREE.PlaneGeometry(1, 1);
    sheet.rotateX(-Math.PI / 2);
    this.smoke = new THREE.InstancedMesh(sheet, new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false, roughness: 1, side: THREE.DoubleSide }), nb);
    this.smoke.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nb * 3), 3);
    this.smoke.renderOrder = 2;
    this.group.add(this.flames, this.smoke);

    // fire start marker
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.75, 32), new THREE.MeshBasicMaterial({ color: '#d64545', side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(result.fire.x, 0.03, result.fire.y);
    this.group.add(ring);
    this.light = new THREE.PointLight('#ff7a1a', 0, 30, 1.5);
    this.light.position.set(result.fire.x, 1.5, result.fire.y);
    this.group.add(this.light);
    this.setTime(0);
  }

  get duration() {
    const f = this.result?.frames.times;
    return f ? f[f.length - 1] : 0;
  }

  setTime(t) {
    const r = this.result;
    if (!r) return;
    this.t = t;
    const { times, pos, state } = r.frames;
    const every = r.frames.every;
    const a = Math.min(times.length - 1, Math.max(0, Math.floor(t / every)));
    const b = Math.min(times.length - 1, a + 1);
    const f = b > a ? Math.min(1, Math.max(0, (t - times[a]) / (times[b] - times[a]))) : 0;
    const m = new THREE.Matrix4();
    const N = r.people.length;
    const P = pos[a], Q = pos[b], S = state[a];
    for (let k = 0; k < N; k++) {
      const st = S[k];
      const x = P[2 * k] + (Q[2 * k] - P[2 * k]) * f, y = P[2 * k + 1] + (Q[2 * k + 1] - P[2 * k + 1]) * f;
      if (st === STATE.OUT) m.makeScale(0, 0, 0);
      else if (st === STATE.OVERCOME) m.makeRotationZ(Math.PI / 2).setPosition(x - 0.7, 0.2, y);
      else m.makeTranslation(x, 0, y);
      this.people.setMatrixAt(k, m);
      this.people.setColorAt(k, STATE_COLOR[st] || STATE_COLOR[STATE.MOVING]);
    }
    this.people.instanceMatrix.needsUpdate = true;
    this.people.instanceColor.needsUpdate = true;

    // smoke hangs under the ceiling and comes down as it thickens; flames flicker
    const hz = r.hazard, top = this.viewer.wallHeight, col = new THREE.Color();
    let burning = 0;
    this.blocks.forEach((bl, n) => {
      const s = smokeAt(hz, bl.i, t);
      if (s < 0.03) m.makeScale(0, 0, 0);
      else {
        m.makeScale(bl.sx, 1, bl.sy).setPosition(bl.x, top - s * (top - 0.5), bl.y);
      }
      this.smoke.setMatrixAt(n, m);
      this.smoke.setColorAt(n, col.setScalar(0.8 - 0.55 * s));
      const age = t - hz.fireT[bl.i];
      if (age < 0) m.makeScale(0, 0, 0);
      else {
        burning++;
        const hgt = Math.min(1.8, 0.3 + age / 30) * (0.75 + 0.25 * Math.sin(t * 7 + bl.seed));
        m.makeScale(bl.sx * 0.9, hgt, bl.sy * 0.9).setPosition(bl.x, 0, bl.y);
      }
      this.flames.setMatrixAt(n, m);
      this.flames.setColorAt(n, col.set(age > 60 ? '#b3261e' : '#ff8a1a'));
    });
    this.smoke.instanceMatrix.needsUpdate = true;
    this.smoke.instanceColor.needsUpdate = true;
    this.flames.instanceMatrix.needsUpdate = true;
    this.flames.instanceColor.needsUpdate = true;
    this.light.intensity = burning ? Math.min(40, 4 + burning * 0.6) : 0;
  }

  // counts at time t for the playback readout
  countsAt(t) {
    const r = this.result;
    const a = Math.min(r.frames.times.length - 1, Math.max(0, Math.floor(t / r.frames.every)));
    const S = r.frames.state[a];
    const n = [0, 0, 0, 0, 0];
    for (const s of S) n[s]++;
    return { waiting: n[STATE.WAITING], moving: n[STATE.MOVING], out: n[STATE.OUT], overcome: n[STATE.OVERCOME], trapped: n[STATE.TRAPPED] };
  }
}

// two indexed geometries into one (keeps three's addons out of the import list)
function mergeGeometries(a, b) {
  a = a.toNonIndexed(); b = b.toNonIndexed();
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const A = a.getAttribute(name).array, B = b.getAttribute(name).array;
    const arr = new Float32Array(A.length + B.length);
    arr.set(A); arr.set(B, A.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return g;
}
