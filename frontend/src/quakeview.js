// 3D playback of an earthquake: the building shakes, wall panels tip over from their base and
// break into rubble with a puff of dust, tall shelves topple, jammed doors turn red.
import * as THREE from 'three';
import { shakeAt } from './quake.js';
import { OBJECT_STYLE } from './viewer3d.js';

const FALL_S = 1.1; // a 2.6 m wall falls flat in about a second (free rotation about its base)
const DUST_S = 5;
const WALL = '#eef0f3', RUBBLE = ['#c9c5bd', '#b7b1a6', '#d8d4cc', '#a59f94'];

export class QuakeView {
  constructor(viewer, group, result, site) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.name = 'quake';
    group.add(this.group);
    this.q = result.quake;
    const g = site.grid, c = g.cell_m, H = viewer.wallHeight;
    this.c = c;
    const rand = mulberry(7);

    // the panels that fall are taken out of the static model and drawn here
    const cells = new Set();
    for (const p of this.q.panels) for (let y = p.rect[1]; y < p.rect[1] + p.rect[3]; y++) for (let x = p.rect[0]; x < p.rect[0] + p.rect[2]; x++) cells.add(y * g.w + x);
    viewer.setHidden({ cells, objects: new Set(this.q.topples.map((t) => t.id)) });

    const wallMat = new THREE.MeshStandardMaterial({ color: WALL, roughness: 0.85 });
    this.fallers = [];
    // a wall panel: a slab hinged at the foot of the face it falls towards
    for (const p of this.q.panels) {
      const [rx, ry, rw, rh] = p.rect;
      const along = p.horiz ? [1, 0] : [0, 1], dir = p.horiz ? [0, p.side] : [p.side, 0];
      const L = (p.horiz ? rw : rh) * c, T = (p.horiz ? rh : rw) * c;
      const cx = (rx + rw / 2) * c, cy = (ry + rh / 2) * c;
      const hinge = [cx + dir[0] * T / 2, cy + dir[1] * T / 2];
      this.fallers.push(this._faller(new THREE.BoxGeometry(p.horiz ? L : T, H, p.horiz ? T : L), wallMat, hinge, along, dir, T, H, p.t, rand() * 6.28, true));
    }
    // a toppling shelf: hinged at its foot on the side it falls
    const objById = new Map((site.objects || []).map((o) => [o.id, o]));
    const objMat = (cat) => new THREE.MeshStandardMaterial({ color: (OBJECT_STYLE[cat] || OBJECT_STYLE.other).color, roughness: 0.8 });
    for (const tp of this.q.topples) {
      const ob = objById.get(tp.id);
      if (!ob) continue;
      const [A, B, , D] = ob.polygon;
      const e1 = [B[0] - A[0], B[1] - A[1]], e2 = [D[0] - A[0], D[1] - A[1]];
      const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
      const [long, L, T] = l1 >= l2 ? [e1, l1, l2] : [e2, l2, l1];
      const along = [long[0] / L, long[1] / L];
      const mid = ob.polygon.reduce(([a, b], [x, y]) => [a + x / 4, b + y / 4], [0, 0]);
      const hinge = [mid[0] + tp.dir[0] * T / 2, mid[1] + tp.dir[1] * T / 2];
      const geo = new THREE.BoxGeometry(L, tp.height_m, T);
      geo.rotateY(-Math.atan2(along[1], along[0]));
      this.fallers.push(this._faller(geo, objMat(tp.category), hinge, along, tp.dir, T, tp.height_m, tp.t, rand() * 6.28, false));
    }

    // rubble: broken blocks over each fallen panel's debris, lower further from the wall
    const chunks = [];
    const keep = Math.min(1, (0.3 * 0.3) / (c * c));
    for (const p of this.q.panels) {
      for (const i of p.debris || []) {
        if (rand() > keep) continue;
        const x = ((i % g.w) + rand()) * c, y = (((i / g.w) | 0) + rand()) * c;
        const [rx, ry, rw, rh] = p.rect;
        const d = p.horiz ? Math.abs(y - (ry + rh / 2) * c) : Math.abs(x - (rx + rw / 2) * c);
        const s = 0.18 + 0.3 * rand() * Math.max(0.3, 1 - d / (0.6 * H + 0.3));
        chunks.push({ t: p.t + FALL_S * 0.9, x, y, s, h: s * (0.5 + rand() * 0.7), r: rand() * 3.14, col: RUBBLE[(rand() * RUBBLE.length) | 0] });
      }
    }
    const n = Math.max(1, chunks.length);
    this.rubble = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }), n);
    this.rubble.count = chunks.length;
    this.rubble.castShadow = true;
    this.rubble.receiveShadow = true;
    const col = new THREE.Color();
    chunks.forEach((ch, k) => this.rubble.setColorAt(k, col.set(ch.col)));
    this.chunks = chunks;
    this.group.add(this.rubble);

    // dust: a few soft sprites that swell and fade where a wall comes down
    this.dustTex = dustTexture();
    this.dust = [];
    for (const p of this.q.panels) {
      const [rx, ry, rw, rh] = p.rect;
      for (let k = 0; k < 6; k++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dustTex, color: '#bdb6aa', transparent: true, depthWrite: false, opacity: 0 }));
        const off = (rand() - 0.5);
        s.userData = { t: p.t + FALL_S * 0.7, x: (rx + rw / 2) * c + (p.horiz ? off * rw * c : p.side * (0.4 + rand())), y: (ry + rh / 2) * c + (p.horiz ? p.side * (0.4 + rand()) : off * rh * c), grow: 1.5 + rand() * 2 };
        s.visible = false;
        this.group.add(s);
        this.dust.push(s);
      }
    }

    // doors jammed by the shaking: a red frame
    this.jams = [];
    const jamMat = new THREE.MeshBasicMaterial({ color: '#d64545', transparent: true, opacity: 0.75 });
    for (const ev of this.q.events.filter((e) => e.type === 'door')) {
      const door = site.doors.find((d) => d.id === ev.id);
      if (!door?.cells?.length) continue;
      const box = new THREE.Mesh(new THREE.BoxGeometry(c, 2.1, c), jamMat);
      const m = new THREE.InstancedMesh(box.geometry, jamMat, door.cells.length);
      const mx = new THREE.Matrix4();
      door.cells.forEach(([x, y], k) => m.setMatrixAt(k, mx.makeTranslation((x + 0.5) * c, 1.05, (y + 0.5) * c)));
      m.userData.t = ev.t;
      m.visible = false;
      this.group.add(m);
      this.jams.push(m);
    }
  }

  _faller(geo, mat, hinge, along, dir, T, H, t, seed, breaks) {
    // pivot at the hinge; the slab stands on it, its face on the hinge line
    const pivot = new THREE.Group();
    pivot.position.set(hinge[0], 0, hinge[1]);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-dir[0] * T / 2, H / 2, -dir[1] * T / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    this.group.add(pivot);
    // turning about the panel's own axis; the sign makes the top go the way it falls
    const axis = new THREE.Vector3(along[0], 0, along[1]);
    const sign = Math.sign(-along[1] * dir[0] + along[0] * dir[1]) || 1;
    return { pivot, axis, sign, t, seed, breaks };
  }

  update(t) {
    const q = this.q;
    const shake = shakeAt(q, t);
    // the whole building moves with the ground (shown larger than life so it reads on screen)
    const amp = 0.18 * (q.pga / 0.5) * shake, now = performance.now() / 1000;
    const off = [amp * Math.sin(now * 23), amp * 0.7 * Math.sin(now * 17 + 1)];
    this.viewer.root.position.set(off[0], 0, off[1]);
    this.group.parent.position.set(off[0], 0, off[1]);

    const quat = new THREE.Quaternion();
    for (const f of this.fallers) {
      let angle;
      if (t < f.t) angle = 0.04 * shake * Math.sin(now * 19 + f.seed); // rocking before it goes
      else if (t < f.t + FALL_S) { const u = (t - f.t) / FALL_S; angle = (Math.PI / 2) * u * u; } // speeds up as it falls
      else angle = Math.PI / 2;
      f.pivot.quaternion.copy(quat.setFromAxisAngle(f.axis, f.sign * angle));
      // a fallen wall breaks up: the slab gives way to its rubble
      f.pivot.visible = !f.breaks || t < f.t + FALL_S * 1.05;
    }
    const m = new THREE.Matrix4(), rot = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.chunks.forEach((ch, k) => {
      if (t < ch.t) m.makeScale(0, 0, 0);
      else m.compose(pos.set(ch.x, ch.h / 2, ch.y), rot.setFromAxisAngle(up, ch.r), sc.set(ch.s, ch.h, ch.s * 0.8));
      this.rubble.setMatrixAt(k, m);
    });
    this.rubble.instanceMatrix.needsUpdate = true;
    if (this.rubble.instanceColor) this.rubble.instanceColor.needsUpdate = true;
    for (const s of this.dust) {
      const a = (t - s.userData.t) / DUST_S;
      s.visible = a > 0 && a < 1;
      if (!s.visible) continue;
      const r = 0.8 + s.userData.grow * Math.sqrt(a);
      s.position.set(s.userData.x, 0.4 + 1.2 * a, s.userData.y);
      s.scale.set(r * 2, r * 1.4, 1);
      s.material.opacity = 0.75 * (1 - a);
    }
    for (const j of this.jams) j.visible = t >= j.userData.t;
  }

  dispose() {
    this.viewer.root.position.set(0, 0, 0);
    this.group.parent?.position.set(0, 0, 0);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.group.parent?.remove(this.group);
    this.dustTex.dispose();
    this.viewer.setHidden(null);
  }
}

function dustTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const gr = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
