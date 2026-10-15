// 2D correction editor: the plan image with the detected grid on top.
// Paint wall / floor / door cells; every stroke re-runs segmentation.
import { EDIT } from './plan2grid.js';

const KIND_COLORS = ['rgba(0,0,0,0)', 'rgba(91,141,239,0.18)', 'rgba(29,35,43,0.75)', 'rgba(242,165,65,0.85)', 'rgba(47,191,113,0.85)', 'rgba(64,170,230,0.85)'];

export class Editor {
  constructor(canvas, { onChange }) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.tool = EDIT.WALL;
    this.brush = 1;
    this.history = [];
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    addEventListener('pointerup', () => this._up());
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  // base: readPlan() result, seg: segment() result, plan: canvas of the grid area
  set(base, edits, seg, plan) {
    this.base = base; this.edits = edits; this.seg = seg; this.plan = plan;
    this.draw();
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.edits.set(prev);
    this.onChange();
  }

  clear() {
    this.history.push(this.edits.slice());
    this.edits.fill(0);
    this.onChange();
  }

  draw() {
    const parent = this.cv.parentElement;
    const dpr = Math.min(devicePixelRatio, 2);
    const W = parent.clientWidth, H = parent.clientHeight;
    if (!W || !H) return;
    this.cv.width = W * dpr; this.cv.height = H * dpr;
    this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(0, 0, W, H);
    if (!this.seg) return;
    const { w, h, kind } = this.seg;
    const s = Math.min((W - 24) / w, (H - 24) / h);
    const ox = (W - w * s) / 2, oy = (H - h * s) / 2;
    this.view = { s, ox, oy };
    if (this.plan) ctx.drawImage(this.plan, ox, oy, w * s, h * s);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = kind[y * w + x];
      if (!k) continue;
      ctx.fillStyle = KIND_COLORS[k];
      ctx.fillRect(ox + x * s, oy + y * s, Math.ceil(s), Math.ceil(s));
    }
    // outline user edits
    ctx.strokeStyle = '#d6336c';
    ctx.lineWidth = 1;
    for (let i = 0; i < this.edits.length; i++) if (this.edits[i]) {
      ctx.strokeRect(ox + (i % w) * s + 0.5, oy + ((i / w) | 0) * s + 0.5, s - 1, s - 1);
    }
  }

  _cell(e) {
    const r = this.cv.getBoundingClientRect();
    const { s, ox, oy } = this.view;
    return [Math.floor((e.clientX - r.left - ox) / s), Math.floor((e.clientY - r.top - oy) / s)];
  }

  _paint(e) {
    const [cx, cy] = this._cell(e);
    const { w, h } = this.seg;
    const r = this.brush - 1;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      this.edits[y * w + x] = this.tool;
    }
    this._drawStroke(cx, cy);
  }

  _drawStroke(cx, cy) {
    const { s, ox, oy } = this.view;
    const r = this.brush - 1;
    this.ctx.fillStyle = this.tool === EDIT.WALL ? '#1d232b' : this.tool === EDIT.DOOR ? '#f2a541' : '#ffffff';
    this.ctx.fillRect(ox + (cx - r) * s, oy + (cy - r) * s, (2 * r + 1) * s, (2 * r + 1) * s);
  }

  _down(e) {
    if (!this.seg) return;
    this.cv.setPointerCapture(e.pointerId);
    this.history.push(this.edits.slice());
    if (this.history.length > 50) this.history.shift();
    this.painting = true;
    this._paint(e);
  }
  _move(e) { if (this.painting) this._paint(e); }
  _up() {
    if (!this.painting) return;
    this.painting = false;
    this.onChange();
  }
}
