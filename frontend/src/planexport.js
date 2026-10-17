// The projector and camera plan as an A3 landscape PDF and as a DXF for CAD. Both say
// where every projector and camera goes, what each one is for, and how they were placed. Pure
// module: builds the files as bytes or text, without the page.

// ---------- what both files say ----------

const f1 = (v) => Math.round(v * 10) / 10;
const pct = (v) => `${Math.round(v * 100)}%`;

export function planText(site, plan) {
  const P = plan.params.projector, C = plan.params.camera, cov = plan.coverage;
  const zname = (id) => site.zones.find((z) => z.id === id)?.name || id || '';
  const height = plan.projectors[0]?.z ?? plan.params.wallHeight - P.below;
  const how = [
    ['Signs', 'At every door people walk through to get out (normally, or when one exit is blocked): a sign on the floor in front of the door, an EXIT sign above each exit, and an arrow 3 m before the door. Large rooms also get arrows about every 8 m.'],
    ['Projectors', `One on the ceiling 2 m inside the room from each of those doors, so it lights that door's signs; doors close together share one. Then one over each pair of room arrows. A projector only lights its own room, never through a doorway.`],
    ['Cameras', `In a corner of each room, looking diagonally across it, as installers usually do. A second camera (in another corner or on a wall) only where one cannot see ${pct(C.floorShare)} of the room; hung from the ceiling only in open areas far from any wall. Every door is watched from at least one side, and no two cameras face each other.`],
    ['In an emergency', `The cameras spot where a fire starts, which walls fell and which doors jammed (about ${C.delay} s later). The projectors switch on with the alarm, point everyone to the nearest exit that is still open and mark blocked doors as BLOCKED. In an earthquake they show TAKE COVER until the shaking stops.`],
    ['Assumptions', `Projectors on the ceiling at ${f1(height)} m, up to ${P.images} images each, readable up to ${P.maxThrow} m away and at least ${P.minElevation}° from the horizontal. Cameras ${C.fov}° wide and ${C.range} m deep. Furniture is not taken as blocking a camera's view. These positions are a starting point for a site survey, not an installation design.`],
  ];
  const summary = `${plan.projectors.length} projectors and ${plan.cameras.length} cameras · ${cov.targets === 1 ? 'every sign spot is lit' : `${pct(cov.targets)} of sign spots lit`} · the cameras see ${pct(cov.floor)} of the floor and ${cov.doors === 1 ? 'every door' : `${pct(cov.doors)} of the doors`}`;
  // the reasons name the room; the head says how high
  const projectors = plan.projectors.map((p) => ({ id: p.id, head: `ceiling, ${f1(p.z)} m`, room: zname(p.zone), text: p.reason }));
  const cameras = plan.cameras.map((c) => ({ id: c.id, head: `${c.mount}, ${f1(c.z)} m`, room: zname(c.zone), text: c.reason }));
  const warnings = [];
  if (cov.targets_missed.length) warnings.push(`${cov.targets_missed.length} sign spot(s) no projector can reach (shown in red).`);
  if (cov.doors_unseen.length) warnings.push(`Doors no camera sees: ${cov.doors_unseen.join(', ')}.`);
  return { title: `Projector and camera plan — ${site.name || 'site'}`, summary, how, projectors, cameras, warnings };
}

// Rectangles of equal cells: runs along each row, merged down the rows they repeat on.
function blocks(grid, pick) {
  const open = new Map(), out = [];
  for (let y = 0; y <= grid.h; y++) {
    const runs = new Map();
    if (y < grid.h) {
      const row = grid.cells[y];
      for (let x = 0; x < grid.w;) {
        const v = pick(row[x]);
        if (!v) { x++; continue; }
        let e = x + 1;
        while (e < grid.w && pick(row[e]) === v) e++;
        runs.set(`${x}:${e}:${v}`, { x, len: e - x, v });
        x = e;
      }
    }
    for (const [key, b] of open) if (!runs.has(key)) { out.push(b); open.delete(key); }
    for (const [key, r] of runs) if (open.has(key)) open.get(key).rows++; else open.set(key, { ...r, y, rows: 1 });
  }
  return out;
}

const COLOR = { room: '#f3f5f8', wall: '#2b333c', window: '#7cc4e8', door: '#f2a541', exit: '#2fbf71', furniture: '#e2ddd3', stair: '#ddd6c8', proj: '#2f6fe0', cam: '#d64545', sign: '#1f9d55', missed: '#c0392b', text: '#1d232b', muted: '#5a6470' };

// ---------- PDF ----------

// Helvetica advance widths (1/1000 em), ASCII 32..126.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const textWidth = (s, size, bold) => [...s].reduce((w, ch) => w + (HELV[ch.charCodeAt(0) - 32] ?? 556), 0) * (bold ? 1.06 : 1) * size / 1000;
// WinAnsi bytes for the few characters beyond Latin-1 that the text uses
const WIN = { '—': 0x97, '–': 0x96, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95, '…': 0x85, '·': 0xb7, '°': 0xb0 };
const winAnsi = (s) => [...s].map((ch) => { const c = ch.charCodeAt(0); return String.fromCharCode(WIN[ch] ?? (c < 256 ? c : 63)); }).join('');
const pdfStr = (s) => `(${winAnsi(s).replace(/[\\()]/g, (m) => `\\${m}`)})`;
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => +v.toFixed(3)).join(' '); };

function wrap(text, width, size, bold = false) {
  const words = text.split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && textWidth(next, size, bold) > width) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

class Page {
  constructor(W, H) { this.W = W; this.H = H; this.ops = []; }
  y(v) { return +(this.H - v).toFixed(2); }
  fill(hex) { this.ops.push(`${rgb(hex)} rg`); return this; }
  stroke(hex, w = 0.5) { this.ops.push(`${rgb(hex)} RG ${w} w`); return this; }
  alpha(gs) { this.ops.push(`/${gs} gs`); return this; }
  dash(on) { this.ops.push(on ? '[2 1.5] 0 d' : '[] 0 d'); return this; }
  rect(x, y, w, h, mode = 'f') { this.ops.push(`${+x.toFixed(2)} ${this.y(y + h)} ${+w.toFixed(2)} ${+h.toFixed(2)} re ${mode}`); return this; }
  poly(pts, mode = 'f') { this.ops.push(`${pts.map(([x, y], k) => `${+x.toFixed(2)} ${this.y(y)} ${k ? 'l' : 'm'}`).join(' ')} h ${mode}`); return this; }
  line(x0, y0, x1, y1) { this.ops.push(`${+x0.toFixed(2)} ${this.y(y0)} m ${+x1.toFixed(2)} ${this.y(y1)} l S`); return this; }
  circle(x, y, r, mode = 'f') { return this.poly(Array.from({ length: 20 }, (_, k) => [x + r * Math.cos((k * Math.PI) / 10), y + r * Math.sin((k * Math.PI) / 10)]), mode); }
  text(x, y, s, size, { bold = false, color = COLOR.text, align = 'left' } = {}) {
    const w = textWidth(s, size, bold), dx = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${+(x + dx).toFixed(2)} ${this.y(y)} Tm ${pdfStr(s)} Tj ET`);
    return this;
  }
}

function pdfFile(pages) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, k) => `${8 + 2 * k} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /ExtGState /ca 0.14 /CA 0.5 >>',
    '<< /Type /ExtGState /ca 0.6 /CA 0.6 >>',
    '<< /Type /ExtGState /ca 1 /CA 1 >>',
  ];
  for (const page of pages) {
    const content = page.ops.join('\n'), streamId = objs.length + 2;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.W} ${page.H}] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /A1 5 0 R /A2 6 0 R /A3 7 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, k) => { offsets.push(out.length); out += `${k + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0) & 255);
}

// An arrow symbol points up at angle 0: turn it the way the arrow points when nothing is wrong.
const heading = (t) => (t.dir ? Math.atan2(t.dir[0], -t.dir[1]) : 0);

// Sign and device symbols, drawn at (x, y) in page points, s = size.
function arrowPts(x, y, a, s) {
  const p = [[0, -1], [0.8, 0.2], [0.3, 0.2], [0.3, 1], [-0.3, 1], [-0.3, 0.2], [-0.8, 0.2]];
  return p.map(([u, v]) => [x + s * (u * Math.cos(a) - v * Math.sin(a)), y + s * (u * Math.sin(a) + v * Math.cos(a))]);
}
function cameraPts(x, y, a, s) {
  const p = [[-0.9, -0.6], [0.5, -0.6], [0.5, -0.3], [1.1, -0.7], [1.1, 0.7], [0.5, 0.3], [0.5, 0.6], [-0.9, 0.6]];
  return p.map(([u, v]) => [x + s * (u * Math.cos(a) - v * Math.sin(a)), y + s * (u * Math.sin(a) + v * Math.cos(a))]);
}
function wedgePts(x, y, dir, fov, r) {
  const a0 = dir - fov / 2, pts = [[x, y]];
  for (let k = 0; k <= 16; k++) { const a = a0 + (fov * k) / 16; pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
  return pts;
}

export function planPdf(site, plan, { date = new Date() } = {}) {
  const W = 1190.55, H = 841.89, M = 28; // A3 landscape, points
  const pg = new Page(W, H), T = planText(site, plan);
  const g = site.grid, c = g.cell_m;
  // header
  pg.text(M, M + 16, T.title, 17, { bold: true });
  pg.text(M, M + 32, `${T.summary} · ${date.toISOString().slice(0, 10)}`, 9, { color: COLOR.muted });
  // the plan, left; the explanations, right
  const colW = 400, top = M + 48, plW = W - 2 * M - colW - 22, plH = H - top - M;
  const s = Math.min(plW / (g.w * c), plH / (g.h * c)), ox = M, oy = top;
  const X = (m) => ox + m * s, Y = (m) => oy + m * s;
  for (const b of blocks(g, (ch) => (ch === '.' ? 'room' : null))) pg.fill(COLOR.room).rect(X(b.x * c), Y(b.y * c), b.len * c * s + 0.2, b.rows * c * s + 0.2);
  for (const o of site.objects || []) if (o.polygon?.length) pg.fill(o.kind === 'stair' ? COLOR.stair : COLOR.furniture).poly(o.polygon.map(([x, y]) => [X(x), Y(y)]));
  const cellColor = { '#': COLOR.wall, W: COLOR.window, D: COLOR.door, E: COLOR.exit };
  for (const b of blocks(g, (ch) => cellColor[ch] || null)) pg.fill(b.v).rect(X(b.x * c), Y(b.y * c), b.len * c * s + 0.2, b.rows * c * s + 0.2);
  for (const z of site.zones) pg.text(X(z.centroid[0]), Y(z.centroid[1]) - 6, z.name, 8, { bold: true, color: COLOR.muted, align: 'center' });
  for (const d of site.doors || []) if (d.is_exit) pg.text(X(d.x), Y(d.y) - 4, `EXIT ${d.id}`, 6, { bold: true, color: COLOR.sign, align: 'center' });
  // what each camera watches (4 m of its view), then projector aims, signs, devices
  pg.alpha('A1');
  for (const cam of plan.cameras) pg.fill(COLOR.cam).stroke(COLOR.cam, 0.4).poly(wedgePts(X(cam.x), Y(cam.y), cam.dir, (cam.fov * Math.PI) / 180, 4 * s), 'B');
  pg.alpha('A3');
  const tById = new Map(plan.targets.map((t) => [t.id, t]));
  pg.stroke(COLOR.proj, 0.5).dash(true);
  for (const p of plan.projectors) for (const id of p.targets) { const t = tById.get(id); if (t) pg.line(X(p.x), Y(p.y), X(t.x), Y(t.y)); }
  pg.dash(false);
  const sym = Math.max(3, Math.min(7, 0.45 * s));
  for (const t of plan.targets) {
    const col = t.projector ? COLOR.sign : COLOR.missed, x = X(t.x), y = Y(t.y);
    if (t.kind === 'arrow' || t.kind === 'room-arrow') pg.fill(col).poly(arrowPts(x, y, heading(t), sym * 0.8));
    else if (t.kind === 'door-sign') pg.stroke(col, 1).rect(x - sym * 0.7, y - sym * 0.7, sym * 1.4, sym * 1.4, 'S');
    else if (t.kind === 'lintel') pg.fill(col).rect(x - sym, y - sym * 0.3, sym * 2, sym * 0.6);
    else pg.fill('#ce3038').circle(x, y, sym * 0.8).text(x, y + sym * 0.35, 'E', sym, { bold: true, color: '#ffffff', align: 'center' });
  }
  for (const cam of plan.cameras) {
    pg.fill(COLOR.cam).poly(cameraPts(X(cam.x), Y(cam.y), cam.dir, sym * 0.9));
    pg.text(X(cam.x), Y(cam.y) - sym * 1.3, cam.id, Math.max(5, sym * 1.1), { bold: true, color: COLOR.cam, align: 'center' });
  }
  for (const p of plan.projectors) {
    pg.fill('#ffffff').circle(X(p.x), Y(p.y), sym * 1.15).fill(COLOR.proj).circle(X(p.x), Y(p.y), sym).fill('#ffffff').circle(X(p.x), Y(p.y), sym * 0.38);
    pg.text(X(p.x), Y(p.y) - sym * 1.4, p.id, Math.max(5, sym * 1.1), { bold: true, color: COLOR.proj, align: 'center' });
  }
  // scale bar
  const bar = [1, 2, 5, 10, 20].find((m) => m * s >= 60) || 20, by = Math.min(H - M - 4, Y(g.h * c) + 14);
  pg.fill(COLOR.text).rect(ox, by, bar * s, 2).text(ox + bar * s + 4, by + 3, `${bar} m`, 7, { color: COLOR.muted });

  // right column: legend, how, devices; the font shrinks until everything fits on the page
  const cx0 = W - M - colW;
  const legend = [
    ['proj', 'Projector on the ceiling; dashed: the signs it lights'],
    ['cam', 'Camera; shaded: the direction it watches'],
    ['arrow', 'Floor arrow, drawn as it points normally'],
    ['door', 'Floor sign at a door: EXIT, BLOCKED or SMOKE'],
    ['lintel', 'EXIT sign above an exit door'],
    ['ext', 'Extinguisher steps on the wall'],
  ];
  const sections = [
    { head: 'How they were placed, and why', items: T.how.map(([k, v]) => ({ id: `${k}.`, text: v })) },
    { head: `Projectors (${T.projectors.length})`, items: T.projectors.map((p) => ({ id: p.id, sub: p.head, text: p.text, color: COLOR.proj })) },
    { head: `Cameras (${T.cameras.length})`, items: T.cameras.map((d) => ({ id: d.id, sub: d.head, text: d.text, color: COLOR.cam })) },
  ];
  if (T.warnings.length) sections.unshift({ head: 'To check', items: T.warnings.map((w) => ({ id: '!', text: w, color: COLOR.missed })) });
  const legendH = 3 * 14 + 22, avail = H - M - top - legendH;
  let layout = null;
  for (const cols of [1, 2]) {
    const cw = (colW - (cols - 1) * 14) / cols;
    for (let fs = 8; fs >= 4.6 && !layout; fs -= 0.2) {
      const lh = fs * 1.22, items = [];
      for (const sec of sections) {
        items.push({ type: 'head', text: sec.head, h: fs * 1.9 });
        for (const it of sec.items) {
          const idW = textWidth(`${it.id} `, fs, true) + (it.sub ? textWidth(`${it.sub} `, fs, false) : 0);
          const first = wrap(`${it.sub ? `${it.sub} — ` : ''}${it.text}`, cw - textWidth(`${it.id} `, fs, true), fs);
          items.push({ type: 'item', it, lines: first, h: first.length * lh + fs * 0.45, idW });
        }
      }
      // pack into columns
      const columns = [[]];
      let used = 0, ok = true;
      for (const item of items) {
        if (used + item.h > avail) { if (columns.length === cols) { ok = false; break; } columns.push([]); used = 0; }
        columns[columns.length - 1].push(item); used += item.h;
      }
      if (ok) layout = { fs, lh, cw, columns };
    }
    if (layout) break;
  }
  // legend
  let ly = top + 4;
  pg.text(cx0, ly + 6, 'Legend', 9, { bold: true });
  legend.forEach(([k, label], n) => {
    const x = cx0 + (n % 2) * (colW / 2), y = ly + 20 + Math.floor(n / 2) * 14;
    if (k === 'proj') pg.fill(COLOR.proj).circle(x + 5, y - 3, 4).fill('#ffffff').circle(x + 5, y - 3, 1.5);
    else if (k === 'cam') pg.fill(COLOR.cam).poly(cameraPts(x + 5, y - 3, 0, 3.5));
    else if (k === 'arrow') pg.fill(COLOR.sign).poly(arrowPts(x + 5, y - 3, 0, 4));
    else if (k === 'door') pg.stroke(COLOR.sign, 1).rect(x + 2, y - 6, 6, 6, 'S');
    else if (k === 'lintel') pg.fill(COLOR.sign).rect(x + 1, y - 4.5, 8, 3);
    else pg.fill('#ce3038').circle(x + 5, y - 3, 4);
    pg.text(x + 14, y, label, 7, { color: COLOR.text });
  });
  // sections
  if (layout) {
    const { fs, lh, cw, columns } = layout;
    columns.forEach((col, k) => {
      let y = top + legendH;
      const x0 = cx0 + k * (cw + 14);
      for (const item of col) {
        if (item.type === 'head') { pg.text(x0, y + fs * 1.4, item.text, fs * 1.15, { bold: true }); y += item.h; continue; }
        const { it, lines } = item, idw = textWidth(`${it.id} `, fs, true);
        pg.text(x0, y + fs, it.id, fs, { bold: true, color: it.color || COLOR.text });
        lines.forEach((l, n) => pg.text(x0 + idw, y + fs + n * lh, l, fs, { color: n === 0 && it.sub ? COLOR.text : COLOR.text }));
        y += item.h;
      }
    });
  }
  const pages = [pg];
  if (!layout) {
    pg.text(cx0, top + legendH + 14, 'Placement method and device schedules continue on page 2.', 10);
    const fs = 10, lh = 13, width = W - 2 * M, bottom = H - M;
    let page, y;
    const nextPage = () => {
      page = new Page(W, H);
      pages.push(page);
      page.text(M, M + 16, T.title, 17, { bold: true });
      page.text(M, M + 32, `Placement method and device schedules · Page ${pages.length}`, 10, { color: COLOR.muted });
      y = top;
    };
    nextPage();
    for (const sec of sections) {
      const sectionHeading = (continued = false) => {
        page.text(M, y + 14, `${sec.head}${continued ? ' (continued)' : ''}`, 12, { bold: true });
        y += 24;
      };
      if (y + 24 + lh > bottom) nextPage();
      sectionHeading();
      for (const it of sec.items) {
        const idw = textWidth(`${it.id} `, fs, true);
        const lines = wrap(`${it.sub ? `${it.sub} — ` : ''}${it.text}`, width - idw, fs);
        // Keep normal entries together; exceptionally long reasons can span pages.
        if (y + lines.length * lh + 5 > bottom && y > top + 24) {
          nextPage();
          sectionHeading(true);
        }
        for (let n = 0; n < lines.length; n++) {
          if (y + lh > bottom) {
            nextPage();
            sectionHeading(true);
          }
          if (n === 0) page.text(M, y + fs, it.id, fs, { bold: true, color: it.color || COLOR.text });
          page.text(M + idw, y + fs, lines[n], fs);
          y += lh;
        }
        y += 5;
      }
    }
  }
  return pdfFile(pages);
}

// ---------- DXF ----------

// In the original drawing's units and coordinates when the plan came from a DXF (so this file
// overlays it); else in millimetres with the plan's top-left corner at the origin. The building
// goes on standard layers (A-WALL...) so the file opens again as the same plan; the devices go on
// A-ANNO-* layers.
export function planDxf(site, plan) {
  const T = planText(site, plan);
  const f = site.dxf_frame || { x0: 0, y0: 0, k: 1000, units: 4 };
  const X = (x) => +(f.x0 + f.k * x).toFixed(3), Y = (y) => +(f.y0 - f.k * y).toFixed(3), L = (m) => +(f.k * m).toFixed(3);
  const out = [];
  const put = (...pairs) => { for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1])); };
  const ascii = (s) => s.replace(/[—–]/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/°/g, '%%d').replace(/·/g, '-').replace(/[^\x20-\x7e%]/g, '?');
  const layers = [
    // the building on the usual AIA layers, so CAD and OPTEsc read it back as the same plan
    ['A-WALL', 7], ['A-AREA-IDEN', 8], ['A-FURN', 32], ['A-EQPM', 33], ['A-FLOR-STRS', 41],
    // the devices on annotation layers, which a plan reader leaves alone
    ['A-ANNO-PROJECTOR', 5], ['A-ANNO-PROJECTOR-AIM', 150], ['A-ANNO-SIGN', 3],
    ['A-ANNO-CAMERA', 1], ['A-ANNO-CAMERA-VIEW', 11], ['A-ANNO-NOTES', 7],
  ];
  put(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, f.units ?? 4, 0, 'ENDSEC');
  put(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LTYPE', 70, 1, 0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0, 0, 'ENDTAB');
  put(0, 'TABLE', 2, 'LAYER', 70, layers.length);
  for (const [name, color] of layers) put(0, 'LAYER', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS');
  put(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  const line = (layer, x0, y0, x1, y1) => put(0, 'LINE', 8, layer, 10, X(x0), 20, Y(y0), 30, 0, 11, X(x1), 21, Y(y1), 31, 0);
  const poly = (layer, pts, closed = true) => {
    put(0, 'POLYLINE', 8, layer, 66, 1, 10, 0, 20, 0, 30, 0, 70, closed ? 1 : 0);
    for (const [x, y] of pts) put(0, 'VERTEX', 8, layer, 10, X(x), 20, Y(y), 30, 0);
    put(0, 'SEQEND', 8, layer);
  };
  const circle = (layer, x, y, r) => put(0, 'CIRCLE', 8, layer, 10, X(x), 20, Y(y), 30, 0, 40, L(r));
  // plan y runs down, the drawing's up: angles turn the other way
  const arc = (layer, x, y, r, a0, a1) => put(0, 'ARC', 8, layer, 10, X(x), 20, Y(y), 30, 0, 40, L(r), 50, +((-a1 * 180) / Math.PI).toFixed(3), 51, +((-a0 * 180) / Math.PI).toFixed(3));
  const text = (layer, x, y, h, s) => put(0, 'TEXT', 8, layer, 10, X(x), 20, Y(y), 30, 0, 40, L(h), 1, ascii(s));
  // the plan as read: walls (doorways stay open), room names, furniture and stairs
  const g = site.grid, c = g.cell_m;
  for (const b of blocks(g, (ch) => (ch === '#' || ch === 'W' ? 'wall' : null))) {
    const x0 = b.x * c, y0 = b.y * c, x1 = (b.x + b.len) * c, y1 = (b.y + b.rows) * c;
    poly('A-WALL', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  }
  for (const z of site.zones) text('A-AREA-IDEN', z.centroid[0] - 0.1 * z.name.length, z.centroid[1], 0.35, z.name);
  for (const o of site.objects || []) {
    if (!o.polygon?.length) continue;
    if (o.kind === 'stair') {
      poly('A-FLOR-STRS', o.polygon);
      // treads every 28 cm across the long side, as a stair is drawn
      const [a, b2, , d] = o.polygon, L1 = Math.hypot(b2[0] - a[0], b2[1] - a[1]), L2 = Math.hypot(d[0] - a[0], d[1] - a[1]);
      const [p, q, len] = L1 >= L2 ? [b2, d, L1] : [d, b2, L2];
      const u = [(p[0] - a[0]) / len, (p[1] - a[1]) / len], w = [q[0] - a[0], q[1] - a[1]];
      for (let s2 = 0.28; s2 < len - 0.1; s2 += 0.28) line('A-FLOR-STRS', a[0] + u[0] * s2, a[1] + u[1] * s2, a[0] + u[0] * s2 + w[0], a[1] + u[1] * s2 + w[1]);
    } else poly(o.category === 'machine' ? 'A-EQPM' : 'A-FURN', o.polygon);
  }
  // projectors: a circle with a cross, its name, and a line to each sign it lights
  const tById = new Map(plan.targets.map((t) => [t.id, t]));
  for (const p of plan.projectors) {
    circle('A-ANNO-PROJECTOR', p.x, p.y, 0.25);
    line('A-ANNO-PROJECTOR', p.x - 0.18, p.y - 0.18, p.x + 0.18, p.y + 0.18);
    line('A-ANNO-PROJECTOR', p.x - 0.18, p.y + 0.18, p.x + 0.18, p.y - 0.18);
    text('A-ANNO-PROJECTOR', p.x + 0.35, p.y - 0.3, 0.3, `${p.id} h${f1(p.z)}m`);
    for (const id of p.targets) { const t = tById.get(id); if (t) line('A-ANNO-PROJECTOR-AIM', p.x, p.y, t.x, t.y); }
  }
  for (const t of plan.targets) {
    if (t.kind === 'arrow' || t.kind === 'room-arrow') poly('A-ANNO-SIGN', arrowPts(t.x, t.y, heading(t), 0.45));
    else if (t.kind === 'door-sign') poly('A-ANNO-SIGN', [[t.x - 0.4, t.y - 0.4], [t.x + 0.4, t.y - 0.4], [t.x + 0.4, t.y + 0.4], [t.x - 0.4, t.y + 0.4]]);
    else if (t.kind === 'lintel') poly('A-ANNO-SIGN', [[t.x - 0.5, t.y - 0.12], [t.x + 0.5, t.y - 0.12], [t.x + 0.5, t.y + 0.12], [t.x - 0.5, t.y + 0.12]]);
    else circle('A-ANNO-SIGN', t.x, t.y, 0.3);
  }
  // cameras: the body pointing where it looks, its name, a 3 m view wedge and its full range
  for (const cam of plan.cameras) {
    const fov = (cam.fov * Math.PI) / 180;
    poly('A-ANNO-CAMERA', cameraPts(cam.x, cam.y, cam.dir, 0.3));
    text('A-ANNO-CAMERA', cam.x + 0.35, cam.y - 0.3, 0.3, `${cam.id} h${f1(cam.z)}m`);
    for (const a of [cam.dir - fov / 2, cam.dir + fov / 2]) line('A-ANNO-CAMERA-VIEW', cam.x, cam.y, cam.x + 3 * Math.cos(a), cam.y + 3 * Math.sin(a));
    arc('A-ANNO-CAMERA-VIEW', cam.x, cam.y, 3, cam.dir - fov / 2, cam.dir + fov / 2);
  }
  // notes beside the building: the title, how, and each device with its reason
  const nx = g.w * c + 3, h = 0.32;
  let ny = 0;
  const note = (s, size = h) => {
    for (const l of s.match(/.{1,110}(\s|$)/g) || [s]) { text('A-ANNO-NOTES', nx, ny + size, size, l.trim()); ny += size * 1.6; }
  };
  note(T.title, 0.6); note(T.summary); ny += 0.4;
  for (const [k, v] of T.how) note(`${k}: ${v}`);
  ny += 0.4;
  for (const p of T.projectors) note(`${p.id} (${p.head}): ${p.text}`);
  ny += 0.4;
  for (const d of T.cameras) note(`${d.id} (${d.head}): ${d.text}`);
  for (const w of T.warnings) note(`To check: ${w}`);
  put(0, 'ENDSEC', 0, 'EOF');
  return `${out.join('\r\n')}\r\n`;
}
