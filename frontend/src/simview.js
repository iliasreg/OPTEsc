// 3D playback of a fire simulation on top of the site viewer: people, flames and a smoke
// layer that comes down from the ceiling as it thickens.
import * as THREE from 'three';
import { smokeAt, STATE } from './sim.js';

export const PEOPLE_COLORS = { waiting: '#8a94a0', moving: '#2f6fe0', overcome: '#d64545', trapped: '#c98a1a', assist: '#8a5cd6', injured: '#e0457b' };
const STATE_COLOR = {
  [STATE.WAITING]: new THREE.Color(PEOPLE_COLORS.waiting),
  [STATE.MOVING]: new THREE.Color(PEOPLE_COLORS.moving),
  [STATE.OVERCOME]: new THREE.Color(PEOPLE_COLORS.overcome),
  [STATE.TRAPPED]: new THREE.Color(PEOPLE_COLORS.trapped),
  [STATE.ASSIST]: new THREE.Color(PEOPLE_COLORS.assist),
  [STATE.INJURED]: new THREE.Color(PEOPLE_COLORS.injured),
};

// One figure per profile, feet at the origin, facing +x.
const part = (geo, x, y, z, rz = 0) => { if (rz) geo.rotateZ(rz); geo.translate(x, y, z); return geo; };
export const FIGURES = {
  adult: () => mergeGeometries(
    part(new THREE.CylinderGeometry(0.2, 0.22, 1.35, 10), 0, 0.675, 0),
    part(new THREE.SphereGeometry(0.14, 10, 8), 0, 1.55, 0)),
  // a little shorter, head forward
  older: () => mergeGeometries(
    part(new THREE.CylinderGeometry(0.19, 0.22, 1.25, 10), 0, 0.625, 0),
    part(new THREE.SphereGeometry(0.135, 10, 8), 0.07, 1.42, 0)),
  // with a walking stick held out in front
  aid: () => mergeGeometries(
    part(new THREE.CylinderGeometry(0.2, 0.22, 1.3, 10), 0, 0.65, 0),
    part(new THREE.SphereGeometry(0.14, 10, 8), 0, 1.5, 0),
    part(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 6), 0.3, 0.47, 0.18, -0.2)),
  // seated, on a chair with two big wheels
  wheelchair: () => {
    const wheel = (z) => { const g = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16); g.rotateX(Math.PI / 2); return part(g, -0.05, 0.3, z); };
    return mergeGeometries(
      part(new THREE.BoxGeometry(0.5, 0.08, 0.46), 0, 0.5, 0),
      part(new THREE.BoxGeometry(0.06, 0.5, 0.46), -0.24, 0.78, 0),
      wheel(0.27), wheel(-0.27),
      part(new THREE.CylinderGeometry(0.17, 0.19, 0.6, 10), -0.05, 0.85, 0),
      part(new THREE.SphereGeometry(0.13, 10, 8), -0.03, 1.27, 0),
      part(new THREE.BoxGeometry(0.42, 0.14, 0.36), 0.2, 0.6, 0),
      part(new THREE.BoxGeometry(0.12, 0.42, 0.3), 0.38, 0.3, 0));
  },
};

export class SimLayer {
  // QuakeView (quakeview.js) draws earthquake damage; passed in so this module stays light
  constructor(viewer, { QuakeView = null } = {}) {
    this.viewer = viewer;
    this.QuakeView = QuakeView;
    this.group = new THREE.Group();
    viewer.scene.add(this.group);
    this.result = null;
    this.t = 0;
  }

  highlight(event, site) {
    if (event === this.cueEvent && site === this.cueSite) return;
    if (this.cue) {
      this.viewer.scene.remove(this.cue);
      this.cue.geometry.dispose(); this.cue.material.dispose();
    }
    this.cue = null; this.cueEvent = event; this.cueSite = site;
    if (!event || !site) return;
    const { grid } = site, cells = [];
    const zoneIds = event.zoneIds || [], doorIds = event.doorIds || [];
    const zones = new Set(zoneIds.map(id => Number(id.slice(1))));
    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
      if (grid.cells[y][x] === '.' && zones.has(grid.zone_ids[y][x])) cells.push([x, y]);
    }
    for (const door of site.doors) if (doorIds.includes(door.id)) cells.push(...(door.cells || []));
    if (!cells.length) return;
    const isDoor = doorIds.length > 0, c = grid.cell_m;
    const height = isDoor ? 2.2 : 0.025;
    const geometry = new THREE.BoxGeometry(c, height, c);
    const color = isDoor ? '#ffd43b' : event.scenario === 'smoke' ? '#b197fc' : '#ff922b';
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isDoor ? 0.65 : 0.28, depthTest: false, depthWrite: false });
    this.cue = new THREE.InstancedMesh(geometry, material, cells.length);
    this.cue.name = 'drill-subtitle-highlight';
    this.cue.userData = { eventId: event.id, zoneIds, doorIds };
    this.cue.renderOrder = 10;
    const matrix = new THREE.Matrix4();
    cells.forEach(([x,y],i) => this.cue.setMatrixAt(i, matrix.makeTranslation((x+0.5)*c, height/2+0.04, (y+0.5)*c)));
    this.cue.instanceMatrix.needsUpdate = true;
    this.viewer.scene.add(this.cue);
  }

  clear() {
    this.highlight(null, null);
    this.quakeView?.dispose();
    this.quakeView = null;
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

    // people: one figure per profile (a stick, a wheelchair...), coloured by what they are doing
    this.figures = {};
    this.slot = new Int32Array(N);
    this.heading = new Float32Array(N);
    const byProfile = {};
    result.people.forEach((p, k) => { const pr = FIGURES[p.profile] ? p.profile : 'adult'; (byProfile[pr] ??= []).push(k); });
    for (const [pr, list] of Object.entries(byProfile)) {
      const mesh = new THREE.InstancedMesh(FIGURES[pr](), new THREE.MeshStandardMaterial({ roughness: 0.6 }), list.length);
      mesh.castShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
      list.forEach((k, s) => { this.slot[k] = s; });
      this.figures[pr] = { mesh, list };
      this.group.add(mesh);
    }

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

    if (result.quake && this.QuakeView) this.quakeView = new this.QuakeView(this.viewer, this.group, result, site);
    if (!result.fire) { this.light = null; this.setTime(0); return; }
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
    const P = pos[a], Q = pos[b], S = state[a];
    const turn = new THREE.Matrix4();
    for (const { mesh, list } of Object.values(this.figures)) {
      for (const k of list) {
        const st = S[k];
        const dx = Q[2 * k] - P[2 * k], dy = Q[2 * k + 1] - P[2 * k + 1];
        const x = P[2 * k] + dx * f, y = P[2 * k + 1] + dy * f;
        // face the way they walk (figures are built facing +x)
        if (dx * dx + dy * dy > 1e-4) this.heading[k] = Math.atan2(-dy, dx);
        if (st === STATE.OUT) m.makeScale(0, 0, 0);
        else if (st === STATE.OVERCOME || st === STATE.INJURED) m.makeRotationY(this.heading[k]).multiply(turn.makeRotationZ(Math.PI / 2)).setPosition(x, 0.2, y);
        else m.makeRotationY(this.heading[k]).setPosition(x, 0, y);
        mesh.setMatrixAt(this.slot[k], m);
        mesh.setColorAt(this.slot[k], STATE_COLOR[st] || STATE_COLOR[STATE.MOVING]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }

    // smoke hangs under the ceiling and comes down as it thickens; flames flicker
    const hz = r.hazard, top = this.viewer.wallHeight, col = new THREE.Color();
    let burning = 0;
    const zone = hz.kind === 'zone' ? hz.zone : null, sec = zone ? Math.max(0, Math.min(zone.t - 1, Math.floor(t))) : 0;
    this.blocks.forEach((bl, n) => {
      if (zone) {
        // the zone model's smoke layer: its underside at the computed height, darker with soot
        const k = hz.roomOf[bl.i];
        const H = k >= 0 ? hz.net.rooms[k].height : 1, zi = k >= 0 ? zone.zi[k][sec] : H;
        const ext = k >= 0 ? 8700 * zone.soot[k][sec] : 0;
        if (k < 0 || zi > H - 0.02 || ext < 0.02) m.makeScale(0, 0, 0);
        else m.makeScale(bl.sx, 1, bl.sy).setPosition(bl.x, Math.max(0.05, (zi / H) * top), bl.y);
        this.smoke.setMatrixAt(n, m);
        this.smoke.setColorAt(n, col.setScalar(0.85 - 0.65 * Math.min(1, ext / 1.5)));
      } else {
        const s = smokeAt(hz, bl.i, t);
        if (s < 0.03) m.makeScale(0, 0, 0);
        else m.makeScale(bl.sx, 1, bl.sy).setPosition(bl.x, top - s * (top - 0.5), bl.y);
        this.smoke.setMatrixAt(n, m);
        this.smoke.setColorAt(n, col.setScalar(0.8 - 0.55 * s));
      }
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
    if (this.light) this.light.intensity = zone ? Math.min(40, zone.Q[sec] / 100) : burning ? Math.min(40, 4 + burning * 0.6) : 0;
    this.quakeView?.update(t);
  }

  // counts at time t for the playback readout
  countsAt(t) {
    const r = this.result;
    const a = Math.min(r.frames.times.length - 1, Math.max(0, Math.floor(t / r.frames.every)));
    const S = r.frames.state[a];
    const n = new Array(8).fill(0);
    for (const s of S) n[s]++;
    return { waiting: n[STATE.WAITING], moving: n[STATE.MOVING], out: n[STATE.OUT], overcome: n[STATE.OVERCOME], trapped: n[STATE.TRAPPED], assist: n[STATE.ASSIST], injured: n[STATE.INJURED] };
  }
}

// two indexed geometries into one (keeps three's addons out of the import list)
function mergeGeometries(...geos) {
  const flat = geos.map((x) => x.toNonIndexed());
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const arr = new Float32Array(flat.reduce((t, x) => t + x.getAttribute(name).array.length, 0));
    let o = 0;
    for (const x of flat) { arr.set(x.getAttribute(name).array, o); o += x.getAttribute(name).array.length; }
    g.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return g;
}
