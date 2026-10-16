// Furniture, machines and stairs on the site grid. Pure module: used by the page, the
// simulation worker and the tests.

// Furniture, machines and stairs from the drawing (image pixels) in site metres, each tied to
// the room it stands in. Objects outside the building (legends, title blocks) and outlines
// that fill most of a room (a room boundary drawn on a furniture layer) are left out.
export function placeObjects(site, src, objects = []) {
  const g = site.grid, c = g.cell_m;
  if (!src.cellPx || !objects.length) return [];
  const toM = ([px, py]) => [round2(((px - src.originPx[0]) / src.cellPx) * c), round2(((py - src.originPx[1]) / src.cellPx) * c)];
  const floorOf = new Map();
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const z = g.zone_ids[y][x];
    if (z > 0 && g.cells[y][x] === '.') floorOf.set(z, (floorOf.get(z) || 0) + 1);
  }
  const zoneNear = (x, y) => {
    const gx = Math.floor(x / c), gy = Math.floor(y / c), r = Math.ceil(1 / c);
    for (let d = 0; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
      const z = g.zone_ids[gy + dy]?.[gx + dx];
      if (z > 0) return z;
    }
    return 0;
  };
  const out = [];
  let nObj = 0, nStair = 0;
  for (const o of objects) {
    const polygon = o.polygon.map(toM);
    const [cx, cy] = polygon.reduce(([a, b], [x, y]) => [a + x / polygon.length, b + y / polygon.length], [0, 0]);
    const z = zoneNear(cx, cy);
    if (!z) continue;
    // floor cells under the object, by cell centre
    let under = 0;
    const [x0, y0, x1, y1] = polygon.reduce(([a, b, p, q], [x, y]) => [Math.min(a, x), Math.min(b, y), Math.max(p, x), Math.max(q, y)], [Infinity, Infinity, -Infinity, -Infinity]);
    for (let gy = Math.max(0, Math.floor(y0 / c)); gy <= Math.min(g.h - 1, Math.floor(y1 / c)); gy++) {
      for (let gx = Math.max(0, Math.floor(x0 / c)); gx <= Math.min(g.w - 1, Math.floor(x1 / c)); gx++) {
        if (g.zone_ids[gy][gx] === z && g.cells[gy][gx] === '.' && inPolygon(polygon, (gx + 0.5) * c, (gy + 0.5) * c)) under++;
      }
    }
    if (o.kind === 'object' && under > 0.6 * (floorOf.get(z) || 1)) continue;
    const id = o.kind === 'stair' ? `S${++nStair}` : o.kind === 'ramp' ? `R${++nStair}` : `O${++nObj}`;
    out.push({ ...o, id, zone: `Z${z}`, polygon, centroid: [round2(cx), round2(cy)] });
  }
  return out;
}
const round2 = (v) => Math.round(v * 100) / 100;
export function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Grid cells (indices) whose centre lies inside an object's footprint.
export function objectCells(grid, o) {
  const c = grid.cell_m, out = [];
  const [x0, y0, x1, y1] = o.polygon.reduce(([a, b, p, q], [x, y]) => [Math.min(a, x), Math.min(b, y), Math.max(p, x), Math.max(q, y)], [Infinity, Infinity, -Infinity, -Infinity]);
  for (let gy = Math.max(0, Math.floor(y0 / c)); gy <= Math.min(grid.h - 1, Math.floor(y1 / c)); gy++) {
    for (let gx = Math.max(0, Math.floor(x0 / c)); gx <= Math.min(grid.w - 1, Math.floor(x1 / c)); gx++) {
      if (inPolygon(o.polygon, (gx + 0.5) * c, (gy + 0.5) * c)) out.push(gy * grid.w + gx);
    }
  }
  return out;
}
