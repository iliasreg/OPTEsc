// three.js explorer for an OPTEsc site JSON: extruded walls, coloured zones,
// doors and exits, labels, orbit view and first-person walk mode.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { PointerLockControls } from '../vendor/PointerLockControls.js';
import { objectCells } from './objects.js';

const KIND_OF = { o: 0, '.': 1, '#': 2, D: 3, E: 4, W: 5 };
export const TYPE_COLORS = {
  production: '#5b8def', storage: '#e8a33d', office: '#9b7be0', loading_bay: '#e0684b',
  corridor: '#9aa3ad', welfare: '#3fb8a5', unknown: null,
};
const PALETTE = ['#5b8def', '#3fb8a5', '#e8a33d', '#9b7be0', '#e0684b', '#6cc070', '#d36fa8', '#8d9fb8', '#c9b458', '#57b6d9'];
export function zoneColor(zone, index) {
  return TYPE_COLORS[zone.type] || PALETTE[index % PALETTE.length];
}

export class Viewer {
  constructor(container, { onPick } = {}) {
    this.container = container;
    this.onPick = onPick;
    this.wallHeight = 2.6;
    this.showOverlay = false;
    this.showLabels = true;
    this.showObjects = true;
    this.mode = 'orbit';
    this.keys = new Set();

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#dfe6ee');
    this.scene.fog = new THREE.Fog('#dfe6ee', 80, 220);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 1000);

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#8a9099', 1.4));
    const sun = (this.sun = new THREE.DirectionalLight('#ffffff', 1.6));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(sun, sun.target);

    this.orbit = new OrbitControls(this.camera, r.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.walk = new PointerLockControls(this.camera, r.domElement);
    this.walk.addEventListener('unlock', () => this.container.classList.remove('locked'));
    this.walk.addEventListener('lock', () => this.container.classList.add('locked'));

    this.root = new THREE.Group();
    this.scene.add(this.root);

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    r.domElement.addEventListener('click', (e) => this._click(e));
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();

    this.clock = new THREE.Clock();
    r.setAnimationLoop(() => this._tick());
  }

  // dist: metres to the nearest exit per grid cell (for the distance overlay)
  setSite(site, planCanvas = null, dist = null) {
    this.site = site;
    this.planCanvas = planCanvas;
    this.dist = dist;
    this.ifc = null;
    const g = site.grid;
    this.c = g.cell_m;
    this.w = g.w;
    this.h = g.h;
    this.kind = new Uint8Array(g.w * g.h);
    this.zone = new Int32Array(g.w * g.h);
    g.cells.forEach((row, y) => { for (let x = 0; x < g.w; x++) this.kind[y * g.w + x] = KIND_OF[row[x]] ?? 0; });
    g.zone_ids.forEach((row, y) => row.forEach((z, x) => { this.zone[y * g.w + x] = z; }));
    this._build();
    this.frame();
  }

  // Rebuild after a zone rename / type change without moving the camera.
  refresh() { if (this.site && !this.ifc) this._build(); }

  setOverlay(on) { this.showOverlay = on; this.refresh(); }
  // 'zones' or 'distance'
  setColorMode(mode) { this.colorMode = mode; this.refresh(); }
  focusIssue(issue) {
    this.selectedIssue = issue?.id ?? null;
    this.refresh();
    if (issue?.at && this.mode === 'orbit') {
      const [x, z] = issue.at;
      const off = this.camera.position.clone().sub(this.orbit.target);
      this.orbit.target.set(x, 0, z);
      this.camera.position.copy(this.orbit.target).add(off.setLength(Math.min(off.length(), 25)));
    }
  }

  // Show an IFC model (from web-ifc) instead of the site grid.
  showIfc(group) {
    this.ifc = group;
    this.floor = null;
    for (const o of [...this.root.children]) this.root.remove(o);
    this.root.add(group);
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const d = Math.max(size.x, size.z);
    this.orbit.target.set(mid.x, 0, mid.z);
    this.camera.position.set(mid.x, d * 1.05, mid.z + d * 0.45);
    this.sun.position.set(mid.x - d * 0.35, d, mid.z + d * 0.45);
    this.sun.target.position.copy(mid);
    this.orbit.update();
  }
  setLabels(on) { this.showLabels = on; this._labelVis(); }
  // Leave some wall cells and objects out of the model (the earthquake playback animates them).
  setHidden(hidden) {
    if (!hidden && !this.hidden) return;
    this.hidden = hidden;
    this.refresh();
  }
  setObjects(on) { this.showObjects = on; if (this.objects) this.objects.visible = on; }
  // zone labels float above the roofline: useful from above, in the way when walking
  _labelVis() {
    if (!this.labels) return;
    this.labels.visible = this.showLabels;
    for (const s of this.labels.children) {
      if (s.isGroup) continue; // issue pins manage their own visibility
      s.visible = this.mode === 'orbit' || s.userData.exit;
    }
  }
  setWallHeight(hm) { this.wallHeight = hm; this.refresh(); }

  setMode(mode) {
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    this._labelVis();
    if (mode === 'walk') {
      const start = this._walkStart();
      this.camera.position.set(start.x, 1.6, start.z);
      this.camera.lookAt(start.x + 1, 1.6, start.z);
      this.walk.lock();
    } else {
      this.walk.unlock();
      this.frame();
    }
  }

  frame() {
    const W = this.w * this.c, H = this.h * this.c;
    const d = Math.max(W, H);
    this.orbit.target.set(W / 2, 0, H / 2);
    this.camera.position.set(W / 2, d * 1.05, H / 2 + d * 0.45);
    this.orbit.update();
  }

  highlight(zoneId) {
    this.selected = zoneId;
    this.refresh();
  }

  // ---------- scene building ----------

  _build() {
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      o.traverse?.((m) => { m.geometry?.dispose(); m.material?.map?.dispose(); m.material?.dispose(); });
    }
    const { w, h, c } = this;
    const W = w * c, H = h * c;

    // ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 6, H * 6),
      new THREE.MeshStandardMaterial({ color: '#c3cbb8', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, -0.02, H / 2);
    ground.receiveShadow = true;
    this.root.add(ground);

    // floor texture: one texel block per cell
    const S = Math.max(2, Math.min(8, Math.floor(4096 / Math.max(w, h))));
    const cv = document.createElement('canvas');
    cv.width = w * S; cv.height = h * S;
    const ctx = cv.getContext('2d');
    const zoneIdx = new Map(this.site.zones.map((z, i) => [Number(z.id.slice(1)), { z, i }]));
    const byDistance = this.colorMode === 'distance' && this.dist;
    const limit = this.site.egress?.limit_m ?? 45;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = this.kind[y * w + x];
      let col = null;
      if (k === 1 && byDistance) {
        col = distanceColor(this.dist[y * w + x], limit);
      } else if (k === 1) {
        const zi = zoneIdx.get(this.zone[y * w + x]);
        // soft room tints, so furniture, people and fire stand out against the floor
        col = zi ? mix(zoneColor(zi.z, zi.i), '#f4f1ea', 0.5) : '#dfe3e8';
        if (this.selected && zi && zi.z.id !== this.selected) col = mix(col, '#e9edf1', 0.65);
      } else if (k === 3) col = '#f2a541';
      else if (k === 4) col = '#2fbf71';
      else if (k === 2) col = '#3b4048';
      else if (k === 5) col = '#7cc4e8';
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x * S, y * S, S, S);
    }
    // door leaves and swing arcs
    ctx.strokeStyle = '#1d232b';
    ctx.lineWidth = Math.max(1, S / 3);
    for (const d of this.site.doors) {
      if (!d.swing) continue;
      const [hx, hy] = d.swing.hinge.map((v) => (v / c) * S);
      const r = (d.width_m / c) * S;
      const dir = { '+x': [1, 0], '-x': [-1, 0], '+y': [0, 1], '-y': [0, -1] }[d.swing.toward];
      const cx = (d.x / c) * S, cy = (d.y / c) * S;
      const closed = Math.atan2(cy - hy, cx - hx), open = Math.atan2(dir[1], dir[0]);
      let delta = open - closed;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx + r * Math.cos(open), hy + r * Math.sin(open));
      ctx.arc(hx, hy, r, open, closed, delta > 0);
      ctx.stroke();
    }
    if (this.showOverlay && this.planCanvas) {
      ctx.globalAlpha = 0.55;
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(this.planCanvas, 0, 0, cv.width, cv.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = this.showOverlay ? THREE.LinearFilter : THREE.NearestFilter;
    tex.anisotropy = 4;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0.001, H / 2);
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.floor = floor;
    this.root.add(floor);

    // walls: merge cells into rectangles, one instanced box each
    // wall cells the earthquake playback draws itself (panels that fall) are left out here
    const kind = this.hidden?.cells?.size ? this.kind.map((k, i) => (this.hidden.cells.has(i) && (k === 2 || k === 5) ? 0 : k)) : this.kind;
    const wallRects = mergeRects(kind, w, h, (k) => k === 2);
    this.root.add(this._boxes(wallRects, 0, this.wallHeight, '#eef0f3', true));
    // lintels above doors and exits
    const lintel = Math.min(2.1, this.wallHeight - 0.2);
    this.root.add(this._boxes(mergeRects(this.kind, w, h, (k) => k === 3), lintel, this.wallHeight, '#f2a541'));
    this.root.add(this._boxes(mergeRects(this.kind, w, h, (k) => k === 4), lintel, this.wallHeight, '#2fbf71'));
    // windows: sill, glass, lintel
    const win = mergeRects(kind, w, h, (k) => k === 5);
    const sill = Math.min(0.9, lintel - 0.2);
    this.root.add(this._boxes(win, 0, sill, '#eef0f3', true));
    this.root.add(this._boxes(win, lintel, this.wallHeight, '#eef0f3', true));
    const glass = this._boxes(win, sill, lintel, '#9fd3f0');
    glass.material.transparent = true;
    glass.material.opacity = 0.35;
    this.root.add(glass);

    // furniture, machines and stairs
    this.objects = this._objects((this.site.objects || []).filter((o) => !this.hidden?.objects?.has(o.id)));
    this.objects.visible = this.showObjects;
    this.root.add(this.objects);
    // walking bumps into furniture taller than a low table
    this.objMask = new Uint8Array(w * h);
    for (const o of this.site.objects || []) {
      if (o.kind === 'object' && (o.height_m ?? 1) >= 0.4) for (const i of objectCells(this.site.grid, o)) this.objMask[i] = 1;
    }

    // labels
    const ls = Math.max(0.5, Math.min(3, Math.max(W, H) / 40)); // label size follows site size
    const labels = (this.labels = new THREE.Group());
    this.site.zones.forEach((z, i) => {
      const s = label(`${z.name}`, `${z.area_m2} m²`, zoneColor(z, i), ls);
      s.position.set(z.centroid[0], this.wallHeight + 1.2 * ls, z.centroid[1]);
      labels.add(s);
    });
    for (const o of (this.site.objects || []).filter((o) => o.kind === 'stair')) {
      const s = label('Stairs', `${o.treads} steps`, STAIR_COLOR, 0.5 * ls);
      s.position.set(o.centroid[0], this.wallHeight + 0.5, o.centroid[1]);
      s.userData.stair = true;
      labels.add(s);
    }
    for (const d of this.site.doors.filter((d) => d.is_exit)) {
      const s = label('EXIT', d.id, '#2fbf71', 0.6 * ls);
      s.position.set(d.x, this.wallHeight + 0.6, d.y);
      s.userData.exit = true;
      labels.add(s);
    }
    this.root.add(labels);
    this._labelVis();

    // issue pins: red = critical, amber = warning, grey = info
    const pinColor = { critical: '#d64545', warning: '#e0a030', info: '#8a94a0' };
    for (const is of this.site.issues || []) {
      if (!is.at) continue;
      const sel = is.id === this.selectedIssue;
      const pin = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: pinColor[is.severity], emissive: sel ? pinColor[is.severity] : '#000000', emissiveIntensity: 0.6 });
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.35 * ls * (sel ? 1.5 : 1), 16, 12), mat);
      head.position.y = this.wallHeight + 0.4;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * ls, 0.05 * ls, this.wallHeight + 0.4, 6), mat);
      stem.position.y = (this.wallHeight + 0.4) / 2;
      pin.add(head, stem);
      pin.position.set(is.at[0], 0, is.at[1]);
      pin.visible = is.severity !== 'info' || sel;
      labels.add(pin);
    }

    // sun covers the site
    const d = Math.max(W, H);
    // from the default camera side, so the wall faces you look at are lit
    this.sun.position.set(W / 2 - d * 0.35, d, H / 2 + d * 0.45);
    this.sun.target.position.set(W / 2, 0, H / 2);
    const cam = this.sun.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d; cam.near = 1; cam.far = d * 3;
    cam.updateProjectionMatrix();
  }

  // One merged mesh per material: objects as blocks (tables as a top on a base), stairs as steps.
  _objects(objects) {
    const group = new THREE.Group();
    group.name = 'objects';
    const parts = new Map(); // colour -> geometries
    const put = (color, geo) => { if (!parts.has(color)) parts.set(color, []); parts.get(color).push(geo); };
    const top = this.wallHeight;
    for (const o of objects) {
      if (o.kind === 'stair') {
        const [a, b, , d] = o.polygon;
        const n = Math.max(1, o.treads || 1);
        const rise = Math.min(0.19, (top - 0.1) / n);
        for (let k = 0; k < n; k++) {
          // step k covers [k/n, (k+1)/n] of the way from a to b, full width a to d
          const f0 = k / n, f1 = (k + 1) / n;
          const P = (f, g) => [a[0] + (b[0] - a[0]) * f + (d[0] - a[0]) * g, a[1] + (b[1] - a[1]) * f + (d[1] - a[1]) * g];
          put(k % 2 ? STAIR_COLOR : STAIR_EDGE, prism([P(f0, 0), P(f1, 0), P(f1, 1), P(f0, 1)], 0, (k + 1) * rise));
        }
        continue;
      }
      if (o.kind === 'ramp') { put('#d8d2c4', prism(o.polygon, 0, 0.03)); continue; }
      const st = OBJECT_STYLE[o.category] || OBJECT_STYLE.other;
      const hgt = o.height_m ?? st.h;
      if (st.slab) {
        // a top slab on a narrower base reads as a table or a seat, not a crate
        put(st.color, prism(o.polygon, hgt - st.slab, hgt));
        put(st.base, prism(shrink(o.polygon, 0.45), 0, hgt - st.slab));
      } else put(st.color, prism(o.polygon, 0, hgt));
    }
    for (const [color, geos] of parts) {
      const mesh = new THREE.Mesh(mergeAll(geos), new THREE.MeshStandardMaterial({ color, roughness: 0.75 }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  _boxes(rects, y0, y1, color, shadows = false) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, rects.length));
    mesh.count = rects.length;
    const m = new THREE.Matrix4();
    const c = this.c;
    rects.forEach(([x, y, rw, rh], i) => {
      m.makeScale(rw * c, y1 - y0, rh * c);
      m.setPosition((x + rw / 2) * c, (y0 + y1) / 2, (y + rh / 2) * c);
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    return mesh;
  }

  // ---------- interaction ----------

  _walkStart() {
    const z = this.site.zones[0];
    if (!z) return { x: this.w * this.c / 2, z: this.h * this.c / 2 };
    // nearest floor cell of the largest zone to its centroid
    let best = null, bd = Infinity;
    const id = Number(z.id.slice(1));
    for (let i = 0; i < this.w * this.h; i++) if (this.zone[i] === id) {
      const x = (i % this.w + 0.5) * this.c, y = (((i / this.w) | 0) + 0.5) * this.c;
      const dd = (x - z.centroid[0]) ** 2 + (y - z.centroid[1]) ** 2;
      if (dd < bd) { bd = dd; best = { x, z: y }; }
    }
    return best;
  }

  _blocked(x, z) {
    const r = 0.22;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const gx = Math.floor((x + dx) / this.c), gy = Math.floor((z + dz) / this.c);
      if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) continue;
      const k = this.kind[gy * this.w + gx];
      if (k === 2 || k === 5 || (this.showObjects && this.objMask?.[gy * this.w + gx])) return true;
    }
    return false;
  }

  _click(e) {
    if (this.mode === 'walk') { if (!this.walk.isLocked) this.walk.lock(); return; }
    if (!this.floor || !this.onPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.floor)[0];
    if (!hit) return;
    const gx = Math.floor(hit.point.x / this.c), gy = Math.floor(hit.point.z / this.c);
    const z = this.zone[gy * this.w + gx];
    this.onPick(z > 0 ? `Z${z}` : null, [hit.point.x, hit.point.z]);
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.mode === 'orbit') this.orbit.update();
    else if (this.walk.isLocked) {
      const k = this.keys;
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1.6) * dt;
      const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      if (f || s) {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        dir.y = 0; dir.normalize();
        const right = new THREE.Vector3(-dir.z, 0, dir.x);
        const mv = dir.multiplyScalar(f).add(right.multiplyScalar(s)).normalize().multiplyScalar(speed);
        const p = this.camera.position;
        if (!this._blocked(p.x + mv.x, p.z)) p.x += mv.x; // slide along walls
        if (!this._blocked(p.x, p.z + mv.z)) p.z += mv.z;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

// Object looks: colour, default height, and for tables and seats the top slab thickness and base colour.
export const OBJECT_STYLE = {
  table: { color: '#b48a62', base: '#7a6655', h: 0.75, slab: 0.05 },
  seat: { color: '#5f6f82', base: '#3f4955', h: 0.45, slab: 0.08 },
  storage: { color: '#c6cbd2', h: 2.0 },
  bed: { color: '#e4ded2', h: 0.55 },
  sanitary: { color: '#f5f7f9', h: 0.8 },
  kitchen: { color: '#d4d9df', h: 0.9 },
  machine: { color: '#5b6672', h: 1.6 },
  other: { color: '#a3aab3', h: 1.0 },
};
export const STAIR_COLOR = '#c9c1b2';
const STAIR_EDGE = '#b3aa98';

// A footprint polygon (site metres, x and y) extruded from y0 to y1 metres up.
function prism(poly, y0, y1) {
  const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, y1 - y0), bevelEnabled: false });
  // shape y -> world z, extrusion -> world up
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y1, 0);
  return geo;
}
function shrink(poly, f) {
  const [cx, cy] = poly.reduce(([a, b], [x, y]) => [a + x / poly.length, b + y / poly.length], [0, 0]);
  return poly.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]);
}
// Geometries into one (positions and normals), so a floor of furniture is a few draw calls.
function mergeAll(geos) {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const n = flat.reduce((t, g) => t + g.getAttribute('position').count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.getAttribute('position').array, o * 3);
    nor.set(g.getAttribute('normal').array, o * 3);
    o += g.getAttribute('position').count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// Greedy merge of grid cells into rectangles [x, y, w, h].
function mergeRects(kind, w, h, pred) {
  const used = new Uint8Array(w * h);
  const rects = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (used[i] || !pred(kind[i])) continue;
    let rw = 1;
    while (x + rw < w && !used[i + rw] && pred(kind[i + rw])) rw++;
    let rh = 1;
    grow: while (y + rh < h) {
      for (let k = 0; k < rw; k++) {
        const j = (y + rh) * w + x + k;
        if (used[j] || !pred(kind[j])) break grow;
      }
      rh++;
    }
    for (let yy = 0; yy < rh; yy++) for (let k = 0; k < rw; k++) used[(y + yy) * w + x + k] = 1;
    rects.push([x, y, rw, rh]);
  }
  return rects;
}

// Sequential blue ramp from the exit (light) to the limit (dark); past the limit is the
// critical status colour; no route out is grey.
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
export const DIST_COLORS = { ramp: RAMP, over: '#d64545', none: '#9aa0a6' };
function distanceColor(d, limit) {
  if (!Number.isFinite(d)) return DIST_COLORS.none;
  if (d > limit) return DIST_COLORS.over;
  return RAMP[Math.min(RAMP.length - 1, Math.floor((d / limit) * RAMP.length))];
}

function label(title, sub, color, scale = 1) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 160;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRect(ctx, 4, 4, 504, 152, 28); ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, 4, 4, 22, 152, 11); ctx.fill();
  ctx.fillStyle = '#1d232b';
  ctx.font = '600 54px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 48, 58, 440);
  ctx.fillStyle = '#5a6470';
  ctx.font = '40px system-ui, sans-serif';
  ctx.fillText(sub, 48, 118, 440);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(4 * scale, 1.25 * scale, 1);
  s.renderOrder = 10;
  return s;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function mix(a, b, t) {
  const pa = new THREE.Color(a), pb = new THREE.Color(b);
  return '#' + pa.lerp(pb, t).getHexString();
}
