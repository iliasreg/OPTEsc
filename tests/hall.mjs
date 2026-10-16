// Small test buildings on 25 cm cells.

// A walled hall of W x H metres on 25 cm cells. exits: [y0, y1] spans (metres) in the east
// wall; inner: one-cell partitions [x, y0, y1, doorFrom, doorTo] across the hall (metres);
// objects in hall metres.
export function hall(W, H, { exits = [[3, 4]], inner = [], objects = [] } = {}) {
  const c = 0.25, w = W / c + 4, h = H / c + 4, off = 2 * c;
  const cells = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += x < 1 || y < 1 || x >= w - 1 || y >= h - 1 ? 'o' : x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? '#' : '.';
    cells.push(row.split(''));
  }
  const innerDoors = [];
  for (const [x, y0, y1, d0, d1] of inner) {
    const gx = 2 + Math.round(x / c), cellsD = [];
    for (let y = 2 + Math.round(y0 / c); y < 2 + Math.round(y1 / c); y++) {
      const m = (y - 2) * c;
      if (d0 != null && m >= d0 - 1e-9 && m < d1 - 1e-9) { cells[y][gx] = 'D'; cellsD.push([gx, y]); } else cells[y][gx] = '#';
    }
    if (cellsD.length) innerDoors.push({ cells: cellsD, width: d1 - d0, x: (gx + 0.5) * c, y: off + (d0 + d1) / 2 });
  }
  const doors = exits.map(([a, b], k) => {
    const dc = [];
    for (let y = 2 + Math.round(a / c); y < 2 + Math.round(b / c); y++) { cells[y][w - 2] = 'E'; dc.push([w - 2, y]); }
    return { id: `D${k + 1}`, x: (w - 1.5) * c, y: off + (a + b) / 2, width_m: b - a, is_exit: true, connects: ['outside', 'Z1'], cells: dc };
  });
  const move = (o) => ({ ...o, polygon: o.polygon.map(([x, y]) => [x + off, y + off]) });
  return {
    grid: { cell_m: c, w, h, cells: cells.map((r) => r.join('')), zone_ids: cells.map((r) => r.map((ch) => (ch === '.' ? 1 : 0))) },
    zones: [{ id: 'Z1', name: 'Hall', type: 'office', area_m2: W * H, centroid: [W / 2 + off, H / 2 + off] }],
    doors: [...doors, ...innerDoors.map((d, k) => ({ id: `D${doors.length + k + 1}`, x: d.x, y: d.y, width_m: d.width, is_exit: false, connects: ['Z1', 'Z1'], cells: d.cells }))],
    objects: objects.map(move),
  };
}
