// 3D playback of a fire simulation on top of the site viewer: people, flames and a smoke
// layer that comes down from the ceiling as it thickens.
import * as THREE from 'three';
import { smokeAt, STATE } from './sim.js';
import { projectionPlan, projectionDoorKind } from './drillevents.js';

export const PEOPLE_COLORS = { waiting: '#8a94a0', moving: '#2f6fe0', overcome: '#d64545', trapped: '#c98a1a', assist: '#8a5cd6', injured: '#e0457b', killed: '#4a1520' };
const STATE_COLOR = {
  [STATE.WAITING]: new THREE.Color(PEOPLE_COLORS.waiting),
  [STATE.MOVING]: new THREE.Color(PEOPLE_COLORS.moving),
  [STATE.OVERCOME]: new THREE.Color(PEOPLE_COLORS.overcome),
  [STATE.TRAPPED]: new THREE.Color(PEOPLE_COLORS.trapped),
  [STATE.ASSIST]: new THREE.Color(PEOPLE_COLORS.assist),
  [STATE.INJURED]: new THREE.Color(PEOPLE_COLORS.injured),
  [STATE.KILLED]: new THREE.Color(PEOPLE_COLORS.killed),
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
    this.projections = new THREE.Group();
    this.projections.name = 'projected-drill-guidance';
    viewer.scene.add(this.projections);
    this.projectionsEnabled = true;
    this.projectionMaterials = new Map();
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
    this.projections.clear();
    this.projectionGeometry?.dispose(); this.projectionGeometry = null;
    for (const material of this.projectionMaterials.values()) { material.map.dispose(); material.dispose(); }
    this.projectionMaterials.clear(); this.projectionBucket = null; this.projectionTime = null;
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
    this.site = site;
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

    // when each person sets off (first frame on the move): a mark pops up over their head
    this.startAt = new Float32Array(N).fill(Infinity);
    const { times, state: fs } = result.frames;
    for (let f = 0; f < times.length; f++) for (let k = 0; k < N; k++) {
      if (this.startAt[k] === Infinity && (fs[f][k] === STATE.MOVING || fs[f][k] === STATE.OUT)) this.startAt[k] = times[f];
    }
    const mark = new THREE.ConeGeometry(0.13, 0.32, 8);
    mark.rotateX(Math.PI);
    this.marks = new THREE.InstancedMesh(mark, new THREE.MeshBasicMaterial({ color: '#ffd43b' }), N);
    this.marks.frustumCulled = false;
    // a ring round each casualty, seen from far off and over rubble
    const halo = new THREE.RingGeometry(0.5, 0.68, 24);
    halo.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(halo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }), N);
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 3;
    this.group.add(this.marks, this.rings);

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
    // during an earthquake, those not yet moving are taking cover: crouched
    const crouch = !!r.quake;
    for (const { mesh, list } of Object.values(this.figures)) {
      for (const k of list) {
        const st = S[k];
        const dx = Q[2 * k] - P[2 * k], dy = Q[2 * k + 1] - P[2 * k + 1];
        const x = P[2 * k] + dx * f, y = P[2 * k + 1] + dy * f;
        // face the way they walk (figures are built facing +x)
        if (dx * dx + dy * dy > 1e-4) this.heading[k] = Math.atan2(-dy, dx);
        if (st === STATE.OUT) m.makeScale(0, 0, 0);
        else if (st === STATE.OVERCOME || st === STATE.INJURED || st === STATE.KILLED) m.makeRotationY(this.heading[k]).multiply(turn.makeRotationZ(Math.PI / 2)).setPosition(x, st === STATE.KILLED ? 0.12 : 0.2, y);
        else if (crouch && st === STATE.WAITING) m.makeRotationY(this.heading[k]).multiply(turn.makeScale(1.1, 0.55, 1.1)).setPosition(x, 0, y);
        else m.makeRotationY(this.heading[k]).setPosition(x, 0, y);
        mesh.setMatrixAt(this.slot[k], m);
        // the moment they react: a mark over the head for 3 s, bobbing
        const since = t - this.startAt[k];
        if (since >= 0 && since < 3 && st !== STATE.OUT) m.makeScale(1, 1, 1).setPosition(x, 2.0 + 0.12 * Math.sin(since * 8), y);
        else m.makeScale(0, 0, 0);
        this.marks.setMatrixAt(k, m);
        const down = st === STATE.KILLED || st === STATE.INJURED || st === STATE.OVERCOME;
        if (down) m.makeTranslation(x, 0.55, y); else m.makeScale(0, 0, 0);
        this.rings.setMatrixAt(k, m);
        if (down) this.rings.setColorAt(k, STATE_COLOR[st]);
        mesh.setColorAt(this.slot[k], STATE_COLOR[st] || STATE_COLOR[STATE.MOVING]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    this.marks.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.instanceColor.needsUpdate = true;

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
    this.updateProjections(t);
  }

  setProjections(on) {
    this.projectionsEnabled = on;
    this.projections.visible = on;
    if (on && this.result) { this.projectionBucket = null; this.updateProjections(this.t); }
  }

  projectionMaterial(kind, surface = 'floor') {
    const key = `${surface}:${kind}`;
    if (this.projectionMaterials.has(key)) return this.projectionMaterials.get(key);
    const canvas = document.createElement('canvas'); canvas.width = surface==='wall'?1024:512; canvas.height = surface==='wall'?256:512;
    const ctx = canvas.getContext('2d');
    const green = kind === 'arrow' || kind === 'exit';
    ctx.strokeStyle = ctx.fillStyle = green ? '#a1ffbf' : kind === 'smoke' ? '#ffe18a' : '#ff8880';
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 18;
    ctx.lineWidth = 18; ctx.lineCap = 'round'; ctx.textAlign = 'center';
    const text=({arrow:'DRILL',exit:'DRILL EXIT',excluded:'NOT AN EXIT',blocked:'ROUTE BLOCKED',smoke:'SMOKE'})[kind];
    if(surface==='wall') {
      ctx.font='bold 74px sans-serif'; ctx.fillText(`${green?'':'×  '}${text}`,512,156);
    } else {
    if (kind === 'arrow') {
      ctx.beginPath(); ctx.moveTo(256,65); ctx.lineTo(390,220); ctx.lineTo(307,220);
      ctx.lineTo(307,375); ctx.lineTo(205,375); ctx.lineTo(205,220); ctx.lineTo(122,220); ctx.closePath(); ctx.fill();
    } else if (kind === 'exit') {
      ctx.strokeRect(160,70,190,235); ctx.beginPath(); ctx.moveTo(190,190); ctx.lineTo(320,190);
      ctx.moveTo(270,145); ctx.lineTo(320,190); ctx.lineTo(270,235); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(166,95); ctx.lineTo(346,275); ctx.moveTo(346,95); ctx.lineTo(166,275); ctx.stroke();
    }
    ctx.shadowBlur = 6; ctx.font = 'bold 43px sans-serif';
    ctx.fillText(text,256,445);
    }
    const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({map,transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
    ctx.shadowBlur=8; ctx.lineWidth=5; ctx.strokeRect(12,12,canvas.width-24,canvas.height-24);
    material.userData.baseCanvas=canvas;
    this.projectionMaterials.set(key,material); return material;
  }

  updateProjections(t) {
    if (!this.result || !this.projectionsEnabled) return;
    const bucket = Math.floor(t/2);
    if (bucket !== this.projectionBucket || t < this.projectionTime) {
      this.projections.clear();
      this.projectionGeometry ||= new THREE.PlaneGeometry(1,1);
      const plan = projectionPlan(this.site,this.result,t);
      for (const arrow of plan.arrows) {
        const mesh = new THREE.Mesh(this.projectionGeometry,this.projectionMaterial('arrow'));
        mesh.position.set(arrow.x,0.06,arrow.y); mesh.scale.set(1.53,2.34,1);
        mesh.rotation.set(-Math.PI/2,0,Math.atan2(-arrow.dx,-arrow.dy));
        mesh.userData = {surface:'floor',kind:'arrow',path:arrow.path,guards:arrow.guards}; this.projections.add(mesh);
      }
      for (const sign of plan.signs) {
        const door = this.site.doors.find(d=>d.id===sign.id);
        const mesh = new THREE.Mesh(this.projectionGeometry,this.projectionMaterial(sign.kind || 'blocked'));
        mesh.position.set(sign.x,0.065,sign.y); mesh.scale.set(1.65,1.425,1); mesh.rotation.x=-Math.PI/2;
        mesh.userData = {surface:'floor',doorId:sign.id}; this.projections.add(mesh);
        // Fixed on the lintel face, not a camera-facing label suspended in space.
        if (door.is_exit && !this.projections.children.some(m=>m.userData.surface==='wall'&&m.userData.doorId===sign.id)) {
          const wall = new THREE.Mesh(this.projectionGeometry,mesh.material);
          const acrossX = door.along === 'x';
          const normal = Math.sign(acrossX ? sign.y-door.y : sign.x-door.x) || 1;
          wall.rotation.y = acrossX ? normal<0 ? Math.PI : 0 : normal*Math.PI/2;
          wall.position.set(door.x+(acrossX?0:normal*0.065),this.viewer.wallHeight-0.2,door.y+(acrossX?normal*0.065:0));
          wall.scale.set(Math.min(1.7,door.width_m+0.4),0.6,1);
          wall.userData = {surface:'wall',doorId:sign.id}; this.projections.add(wall);
        }
      }
      for(const mesh of this.projections.children.filter(m=>m.userData.surface==='floor')) {
        const fits=()=>{
          mesh.updateMatrixWorld(true);
          const grid=this.site.grid;
          return [-0.5,0,0.5].every(x=>[-0.5,0,0.5].every(y=>{
            const p=new THREE.Vector3(x,y,0).applyMatrix4(mesh.matrixWorld);
            return grid.cells[Math.floor(p.z/grid.cell_m)]?.[Math.floor(p.x/grid.cell_m)]==='.';
          }));
        };
        for(let n=0;n<8&&!fits();n++) mesh.scale.multiplyScalar(0.85);
        mesh.userData.fitsFloor=fits();
      }
      this.projectionBucket = bucket;
    }
    // Withdraw a cached arrow immediately if its path changes before the next replan.
    const hz = this.result.hazard;
    for (const mesh of this.projections.children) {
      const data=mesh.userData;
      if (data.path) mesh.visible=data.fitsFloor && data.guards.every(i=>hz.fireT[i]>t+2 && smokeAt(hz,i,t)<0.1);
      else {
        const d=this.site.doors.find(d=>d.id===data.doorId), kind=projectionDoorKind(d,this.site,this.result,t);
        mesh.visible=!!kind && (data.surface==='floor' ? data.fitsFloor : this.viewer.wallHeight>=2.5);
        if(kind) {mesh.material=this.projectionMaterial(kind,data.surface);data.kind=kind;}
        if(data.surface==='wall') mesh.position.y=this.viewer.wallHeight-0.32;
      }
    }
    this.projectionTime=t;
  }

  // counts at time t for the playback readout
  countsAt(t) {
    const r = this.result;
    const a = Math.min(r.frames.times.length - 1, Math.max(0, Math.floor(t / r.frames.every)));
    const S = r.frames.state[a];
    const n = new Array(8).fill(0);
    for (const s of S) n[s]++;
    return { waiting: n[STATE.WAITING], moving: n[STATE.MOVING], out: n[STATE.OUT], overcome: n[STATE.OVERCOME], trapped: n[STATE.TRAPPED], assist: n[STATE.ASSIST], injured: n[STATE.INJURED], killed: n[STATE.KILLED] };
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
