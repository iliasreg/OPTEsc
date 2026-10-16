// Projectors and cameras in the 3D view, on the ceiling, and during a drill a faint beam from
// each projector to the signs it is showing.
import * as THREE from 'three';
import { assignSigns } from './equipment.js';

const PROJ_COLOR = '#2f6fe0', CAM_COLOR = '#d64545';

export class EquipmentView {
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.name = 'projectors-and-cameras';
    viewer.scene.add(this.group);
    this.visible = true;
  }

  setPlan(plan) {
    this.clear();
    this.plan = plan;
    if (!plan) return;
    const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    for (const p of plan.projectors) {
      // a short housing hanging from the ceiling, lens down
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 16), mat('#2b333c'));
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 16), new THREE.MeshBasicMaterial({ color: PROJ_COLOR }));
      lens.position.y = -0.13;
      g.add(body, lens);
      g.position.set(p.x, p.z, p.y);
      g.userData = { kind: 'projector', id: p.id };
      this.group.add(g, label(p.id, PROJ_COLOR, p.x, p.z + 0.35, p.y));
    }
    for (const c of plan.cameras) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.12), mat('#e8ebef'));
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 12), new THREE.MeshBasicMaterial({ color: CAM_COLOR }));
      lens.rotation.z = Math.PI / 2;
      lens.position.x = 0.16;
      g.add(body, lens);
      // facing c.dir in plan (x east, y south), tilted down towards the floor
      g.rotation.set(0, -c.dir, -0.45, 'YXZ');
      g.position.set(c.x, c.z, c.y);
      g.userData = { kind: 'camera', id: c.id };
      this.group.add(g, label(c.id, CAM_COLOR, c.x, c.z + 0.3, c.y));
    }
    this.beams = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#7fb2ff', transparent: true, opacity: 0.55, depthWrite: false }));
    this.beams.frustumCulled = false;
    this.group.add(this.beams);
    this.group.visible = this.visible;
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
  }

  // the projection meshes now on show (simview.js): draw a beam from each one's projector
  showBeams(meshes) {
    if (!this.plan || !this.beams) return;
    const shown = meshes.filter((m) => m.visible).map((m) => ({ x: m.position.x, y: m.position.z, h: m.position.y, surface: m.userData.surface || 'floor', projector: m.userData.projector }));
    const pts = [];
    const byId = new Map(this.plan.projectors.map((p) => [p.id, p]));
    // signs drawn from the plan know their projector; others are matched by position
    for (const s of [...shown.filter((x) => x.projector), ...assignSigns(this.plan, shown.filter((x) => !x.projector))]) {
      const p = byId.get(s.projector);
      if (p) pts.push(p.x, p.z - 0.15, p.y, s.x, s.h, s.y);
    }
    this.beams.geometry.dispose();
    this.beams.geometry = new THREE.BufferGeometry();
    this.beams.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  clearBeams() { if (this.beams) this.showBeams([]); }

  clear() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    this.group.clear();
    this.beams = null;
    this.plan = null;
  }
}

// a small floating name tag ("P3", "C2")
function label(text, color, x, y, z) {
  const canvas = document.createElement('canvas');
  canvas.width = 96; canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect?.(4, 4, 88, 40, 10); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 48, 25);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false }));
  sprite.scale.set(0.7, 0.35, 1);
  sprite.position.set(x, y, z);
  sprite.renderOrder = 12;
  return sprite;
}
