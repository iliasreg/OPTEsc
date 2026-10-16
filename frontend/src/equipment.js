// Where to put the projectors that show the drill signs, and the cameras that tell them what is
// happening, placed by the rules an installer would follow and each with the reason it is there.
// Pure module: used by the page, the exports and the tests.
//
// Sign spots: at every door on the way out, the sign on the floor in front of the door, the
// exit sign above an exit and the arrow leading to the door; in large rooms, arrows every 8 m or
// so; the extinguisher steps. They are fixed; what they show changes with what the cameras see.
//
// Projectors (assumed: ceiling-mounted, steerable, up to PROJECTOR.images signs at once): one
// above the approach to each door, 2.2 m inside the room, lighting that door's signs; doors close
// together share one; then one over each group of room arrows. A projector only lights its own
// room, from no further than PROJECTOR.maxThrow and steeply enough (PROJECTOR.minElevation) for
// the image to stay readable.
//
// Cameras (assumed: CAMERA.fov wide, CAMERA.range deep): in a room corner looking diagonally
// across the room, as installers do; another on a corner or a wall only where one cannot see the
// whole room. Each watches its own room and its doors; two cameras never face each other.
import { prepare, nearestWalkable, routeField, smokeAt } from './sim.js';
import { projectionDoorKind, projectionCellClear, quakeProjectionShaking } from './drillevents.js';

export const PROJECTOR = { images: 6, maxThrow: 9, minElevation: 25, below: 0.25, inset: 2.2, wallMin: 0.8, wallMax: 7, wallAngle: 55, roomArrowEvery: 8 };
export const CAMERA = { fov: 90, range: 15, below: 0.2, delay: 15, floorShare: 0.97 };
const K = { OUTSIDE: 0, FLOOR: 1, WALL: 2, DOOR: 3, EXIT: 4, WINDOW: 5, OBSTACLE: 6, STAIR: 7 };
const deg = Math.PI / 180;
const roomCell = (k) => k === K.FLOOR || k === K.OBSTACLE || k === K.STAIR;
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
export const compass = (a) => COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];

function context(site) {
  const g = prepare(site);
  const zoneById = new Map(site.zones.map((z) => [z.id, z]));
  const name = (id) => zoneById.get(id)?.name || id;
  const zoneAt = (x, y) => { const cx = Math.floor(x / g.c), cy = Math.floor(y / g.c); return cx < 0 || cy < 0 || cx >= g.w || cy >= g.h ? 0 : g.zone[cy * g.w + cx]; };
  const centre = (i) => [((i % g.w) + 0.5) * g.c, (Math.floor(i / g.w) + 0.5) * g.c];
  // nearest cell of room k (floor, furniture or stairs: a ceiling mount can go over any of them)
  const inRoom = (x, y, k, R = 3) => {
    const cx = Math.floor(x / g.c), cy = Math.floor(y / g.c), r = Math.ceil(R / g.c);
    for (let d = 0; d <= r; d++) {
      let best = -1, bd = Infinity;
      for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const i = ny * g.w + nx;
        if (g.zone[i] !== k || !roomCell(g.kind[i])) continue;
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = i; }
      }
      if (best >= 0) return best;
    }
    return -1;
  };
  return { g, zoneById, name, zoneAt, centre, inRoom };
}

// The way into room id from door d, as a unit vector across the door.
function intoRoom(cx, d, id) {
  const k = Number(id.slice(1));
  const opts = d.along === 'x' ? [[0, 1], [0, -1]] : d.along === 'y' ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1], [1, 0], [-1, 0]];
  let best = opts[0], bn = -1;
  for (const n of opts) {
    let hits = 0;
    for (const s of [0.6, 1, 1.5, 2]) if (cx.zoneAt(d.x + n[0] * s, d.y + n[1] * s) === k) hits++;
    if (hits > bn) { bn = hits; best = n; }
  }
  return best;
}

// "exit D9", "the door to the Corridor (D4)"
function doorLabel(cx, d, fromId) {
  if (d.is_exit) return `exit ${d.id}`;
  const other = (d.connects || []).find((id) => id !== fromId && id !== 'outside');
  return other ? `the door to ${cx.name(other)} (${d.id})` : `door ${d.id}`;
}

// Distance in metres from each cell to the nearest cell outside its room (chessboard steps).
function wallDistance(g) {
  const d = new Float32Array(g.w * g.h).fill(Infinity), q = [];
  for (let i = 0; i < d.length; i++) if (!roomCell(g.kind[i]) || g.zone[i] <= 0) { d[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % g.w, y = (i / g.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const j = ny * g.w + nx;
      if (d[j] > d[i] + 1) { d[j] = d[i] + 1; q.push(j); }
    }
  }
  return d.map((v) => v * g.c);
}

// Down the route field from cell i for up to `metres`: the cells walked through.
function descend(g, field, i, metres) {
  const path = [i];
  for (let n = 0; n < Math.round(metres / g.c) && g.kind[i] !== K.EXIT; n++) {
    const x = i % g.w, y = (i / g.w) | 0;
    let next = -1, best = field[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, j = ny * g.w + nx;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || !(field[j] < best)) continue;
      if (dx && dy && (!Number.isFinite(field[y * g.w + nx]) || !Number.isFinite(field[ny * g.w + x]))) continue;
      next = j; best = field[j];
    }
    if (next < 0) break;
    path.push(next); i = next;
  }
  return path;
}

// The ways out of the building with nothing wrong, and with each exit blocked in turn (the usual
// design check): one route field for each.
function escapeRoutes(g) {
  const n = g.w * g.h, none = { kind: 'none', start: -1, fireT: new Float32Array(n).fill(Infinity), smokeT: new Float32Array(n).fill(Infinity), tau: new Float32Array(n).fill(20) };
  const exits = g.doors.map((d, k) => k).filter((k) => g.doors[k].exit);
  return [-1, ...(exits.length > 1 ? exits : [])].map((blocked) => {
    const field = new Float64Array(n);
    routeField(g, none, 0, field, (i) => g.kind[i] === K.EXIT && g.doorOf[i] !== blocked, (i) => [K.FLOOR, K.DOOR, K.EXIT].includes(g.kind[i]) && !(blocked >= 0 && g.doorOf[i] === blocked));
    return field;
  });
}

// Every spot a sign may be projected on, in metres; z is the height of the image. Signs go at
// doors on the way out: those people walk through to leave, normally or when one exit is blocked.
export function projectionTargets(site, { wallHeight = 2.6, station = null } = {}) {
  const cx = context(site), { g } = cx;
  const routes = escapeRoutes(g);
  const onTheWayOut = (d, s) => d.is_exit || routes.some((f) => Number.isFinite(f[s]) && descend(g, f, s, 4).some((j) => g.doorOf[j] >= 0 && g.doors[g.doorOf[j]].id === d.id));
  const out = [];
  const add = (t) => { out.push({ id: `T${out.length + 1}`, ...t }); return out[out.length - 1]; };
  for (const d of site.doors || []) {
    let lintel = false;
    for (const id of d.connects || []) {
      if (!cx.zoneById.has(id)) continue;
      const k = Number(id.slice(1)), n = intoRoom(cx, d, id);
      const s = nearestWalkable(g, d.x + n[0] * 1.2, d.y + n[1] * 1.2);
      if (s < 0 || g.zone[s] !== k || !onTheWayOut(d, s)) continue;
      const key = `${d.id}:${id}`;
      const [sx, sy] = cx.centre(s);
      add({ kind: 'door-sign', surface: 'floor', x: sx, y: sy, z: 0, zone: id, door: d.id, station: key, normal: n });
      if (d.is_exit && !lintel) {
        lintel = true;
        add({ kind: 'lintel', surface: 'wall', x: d.x + n[0] * 0.07, y: d.y + n[1] * 0.07, z: Math.max(1.9, wallHeight - 0.3), normal: n, zone: id, door: d.id, station: key });
      }
      const a = nearestWalkable(g, d.x + n[0] * 3.2, d.y + n[1] * 3.2);
      if (a >= 0 && g.zone[a] === k) { const [x, y] = cx.centre(a); add({ kind: 'arrow', surface: 'floor', x, y, z: 0, zone: id, door: d.id, station: key }); }
    }
  }
  // room arrows: across large rooms every PROJECTOR.roomArrowEvery metres, a metre or more from
  // the walls, and away from the signs at the doors
  const dist = wallDistance(g), every = PROJECTOR.roomArrowEvery, step = Math.max(1, Math.round(every / g.c));
  for (const z of site.zones) {
    const k = Number(z.id.slice(1));
    const spots = [];
    const c0 = nearestWalkable(g, ...z.centroid);
    if (c0 >= 0 && g.zone[c0] === k) spots.push(c0);
    for (let y = Math.floor(step / 2); y < g.h; y += step) for (let x = Math.floor(step / 2); x < g.w; x += step) {
      const i = nearestWalkable(g, (x + 0.5) * g.c, (y + 0.5) * g.c);
      if (i >= 0 && g.zone[i] === k) spots.push(i);
    }
    for (const i of spots) {
      if (dist[i] < 1) continue;
      const [x, y] = cx.centre(i);
      if (out.some((t) => t.zone === z.id && t.surface === 'floor' && Math.hypot(t.x - x, t.y - y) < every / 2)) continue;
      add({ kind: 'room-arrow', surface: 'floor', x, y, z: 0, zone: z.id });
    }
  }
  // the way each arrow points when nothing is wrong (for the drawings)
  for (const t of out) if (t.kind === 'arrow' || t.kind === 'room-arrow') {
    const i = Math.floor(t.y / g.c) * g.w + Math.floor(t.x / g.c), path = Number.isFinite(routes[0][i]) ? descend(g, routes[0], i, 1) : [i];
    const j = path[path.length - 1];
    t.dir = path.length > 1 ? [round2(((j % g.w) + 0.5) * g.c - t.x), round2((Math.floor(j / g.w) + 0.5) * g.c - t.y)] : null;
  }
  if (station) {
    const nx = Math.sign(station.x - station.wallX) || -1;
    const k = cx.zoneAt(station.x, station.y);
    add({ kind: 'training', surface: 'wall', x: station.wallX + nx * 0.15, y: station.y + 1.65, z: 1.85, normal: [nx, 0], zone: k ? `Z${k}` : null });
  }
  return out;
}

// Straight line on the grid: false if a wall, window or the outside is in the way.
function inSight(g, x0, y0, x1, y1) {
  const c = g.c;
  let cx = Math.floor(x0 / c), cy = Math.floor(y0 / c);
  const ex = Math.floor(x1 / c), ey = Math.floor(y1 / c);
  const dx = x1 - x0, dy = y1 - y0;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = sx ? Math.abs(c / dx) : Infinity, tdy = sy ? Math.abs(c / dy) : Infinity;
  let tx = sx ? ((sx > 0 ? (cx + 1) * c - x0 : x0 - cx * c) / Math.abs(dx)) : Infinity;
  let ty = sy ? ((sy > 0 ? (cy + 1) * c - y0 : y0 - cy * c) / Math.abs(dy)) : Infinity;
  for (let n = 0; n < 4 * (g.w + g.h); n++) {
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return false;
    const k = g.kind[cy * g.w + cx];
    if (k === K.WALL || k === K.WINDOW || k === K.OUTSIDE) return false;
    if (cx === ex && cy === ey) return true;
    if (tx < ty) { tx += tdx; cx += sx; } else { ty += tdy; cy += sy; }
  }
  return true;
}

// Can a projector at (x, y, z) put a legible image on target t?
export function reaches(g, p, t, P = PROJECTOR) {
  const hx = t.x - p.x, hy = t.y - p.y, horiz = Math.hypot(hx, hy), drop = p.z - t.z;
  if (Math.hypot(horiz, drop) > P.maxThrow) return false;
  if (t.surface === 'floor') {
    if (Math.atan2(drop, horiz) < P.minElevation * deg) return false;
  } else {
    // in front of the wall, not too close, not too far, not too far off to the side
    const along = -(hx * t.normal[0] + hy * t.normal[1]);
    if (along < P.wallMin || horiz > P.wallMax || Math.acos(Math.min(1, along / (horiz || 1))) > P.wallAngle * deg) return false;
  }
  return inSight(g, p.x, p.y, t.x, t.y);
}

export function placeProjectors(site, targets, { wallHeight = 2.6 } = {}) {
  const cx = context(site), { g } = cx, P = PROJECTOR, z = wallHeight - P.below;
  const byId = new Map(targets.map((t) => [t.id, t]));
  const mount = (x, y, zone) => { const i = cx.inRoom(x, y, Number(zone.slice(1))); if (i < 0) return null; const [px, py] = cx.centre(i); return { x: px, y: py, z }; };
  const can = (p, ids) => ids.every((id) => reaches(g, p, byId.get(id)));
  const list = [];
  // 1. above the approach to each door, lighting that door's signs
  const stations = new Map();
  for (const t of targets) if (t.station) (stations.get(t.station) || stations.set(t.station, []).get(t.station)).push(t);
  for (const ts of stations.values()) {
    const sign = ts.find((t) => t.kind === 'door-sign'), d = site.doors.find((x) => x.id === sign.door);
    const p = mount(d.x + sign.normal[0] * P.inset, d.y + sign.normal[1] * P.inset, sign.zone);
    if (!p) continue;
    const ids = ts.map((t) => t.id).filter((id) => reaches(g, p, byId.get(id)));
    if (ids.length) list.push({ ...p, zone: sign.zone, targets: ids, role: 'door' });
  }
  // 2. doors close together share a projector between them, if it reaches all their signs
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < list.length && !merged; a++) for (let b = a + 1; b < list.length && !merged; b++) {
      const A = list[a], B = list[b];
      if (A.zone !== B.zone || A.role !== 'door' || B.role !== 'door' || Math.hypot(A.x - B.x, A.y - B.y) > 3.5) continue;
      const ids = [...A.targets, ...B.targets];
      if (ids.length > P.images) continue;
      const p = mount((A.x + B.x) / 2, (A.y + B.y) / 2, A.zone);
      if (!p || !can(p, ids)) continue;
      list.splice(b, 1);
      list[a] = { ...p, zone: A.zone, targets: ids, role: 'door' };
      merged = true;
    }
  }
  // 3. the rest (room arrows, the extinguisher steps, any door sign not yet lit): an existing
  // projector in the same room if it has room to spare, else a new one over the group
  const covered = new Set(list.flatMap((p) => p.targets));
  for (const t of targets) {
    if (covered.has(t.id) || !t.zone) continue;
    const host = list.filter((p) => p.zone === t.zone && p.targets.length < P.images && reaches(g, p, t))
      .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y))[0];
    if (host) { host.targets.push(t.id); covered.add(t.id); continue; }
    let p;
    if (t.surface === 'wall') p = mount(t.x + t.normal[0] * 2.5, t.y + t.normal[1] * 2.5, t.zone);
    else {
      // over the middle of this spot and its uncovered neighbours in the room
      const group = targets.filter((u) => !covered.has(u.id) && u.zone === t.zone && u.surface === 'floor' && Math.hypot(u.x - t.x, u.y - t.y) < 2 * Math.min(P.maxThrow, z / Math.tan(P.minElevation * deg)) - 0.5)
        .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y)).slice(0, 2);
      p = mount(group.reduce((s, u) => s + u.x, 0) / group.length, group.reduce((s, u) => s + u.y, 0) / group.length, t.zone);
    }
    if (!p) continue;
    const ids = targets.filter((u) => !covered.has(u.id) && u.zone === t.zone && reaches(g, p, u))
      .sort((a, b) => (a.id === t.id ? -1 : b.id === t.id ? 1 : Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)))
      .slice(0, P.images).map((u) => u.id);
    if (!ids.includes(t.id)) continue;
    for (const id of ids) covered.add(id);
    list.push({ ...p, zone: t.zone, targets: ids, role: t.kind === 'training' ? 'training' : 'room' });
  }
  const projectors = list.map((p, n) => ({ id: `P${n + 1}`, x: round2(p.x), y: round2(p.y), z: round2(p.z), zone: p.zone, targets: p.targets, role: p.role }));
  for (const p of projectors) p.reason = projectorReason(cx, site, p, byId);
  return { projectors, missed: targets.filter((t) => !covered.has(t.id)).map((t) => t.id) };
}

function projectorReason(cx, site, p, byId) {
  const ts = p.targets.map((id) => byId.get(id));
  const room = cx.name(p.zone);
  const doors = [...new Set(ts.filter((t) => t.door).map((t) => t.door))].map((id) => site.doors.find((d) => d.id === id));
  const parts = [];
  if (doors.length) {
    const lintel = ts.some((t) => t.kind === 'lintel');
    parts.push(`${doors.length === 1 ? `Just inside ${room} from ${doorLabel(cx, doors[0], p.zone)}` : `In ${room}, between ${doors.map((d) => doorLabel(cx, d, p.zone)).join(' and ')}`}: lights the floor sign in front of ${doors.length === 1 ? 'the door' : 'each door'}${lintel ? ', the EXIT sign above it' : ''} and the arrow leading to it`);
  }
  const arrows = ts.filter((t) => t.kind === 'room-arrow').length;
  if (arrows) parts.push(`${parts.length ? 'also' : `Over ${room}:`} ${arrows} floor arrow${arrows > 1 ? 's' : ''} pointing everyone in this part of the room to the nearest open exit`);
  if (ts.some((t) => t.kind === 'training')) parts.push(`${parts.length ? 'and' : 'In front of the extinguisher:'} the four extinguisher steps on the wall beside it`);
  return `${parts.join('; ')}.`;
}

export function placeCameras(site, { wallHeight = 2.6 } = {}) {
  const cx = context(site), { g } = cx, C = CAMERA, z = wallHeight - C.below;
  const step = Math.max(1, Math.round(1 / g.c));
  // two cameras facing each other, or side by side, would waste one
  const look = (p, q) => Math.abs(((Math.atan2(q.y - p.y, q.x - p.x) - p.dir + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < 25 * deg;
  const facing = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 3 || (look(a, b) && look(b, a));
  const rooms = [];
  for (const zone of site.zones) {
    const k = Number(zone.id.slice(1));
    const mine = (i) => i >= 0 && i < g.w * g.h && g.zone[i] === k && roomCell(g.kind[i]);
    // what this room's cameras watch: its floor every metre, and its doors
    const samples = [];
    for (let y = Math.floor(step / 2); y < g.h; y += step) for (let x = Math.floor(step / 2); x < g.w; x += step) {
      const i = y * g.w + x;
      if (mine(i)) samples.push({ id: `f${i}`, i });
    }
    // a door is watched where people cross it: the floor just inside it, in the middle
    for (const d of (site.doors || []).filter((dd) => (dd.connects || []).includes(zone.id))) {
      const n = intoRoom(cx, d, zone.id), i = cx.inRoom(d.x + n[0] * 0.6, d.y + n[1] * 0.6, k, 1.5);
      if (i >= 0) samples.push({ id: `d${d.id}`, i, door: d.id });
    }
    if (!samples.some((sm) => !sm.door)) continue;
    // where a camera can go: a corner, looking diagonally into the room, or a wall, looking
    // straight out from it
    const cands = [];
    for (let y = 1; y < g.h - 1; y++) for (let x = 1; x < g.w - 1; x++) {
      const i = y * g.w + x;
      if (!mine(i) || g.kind[i] !== K.FLOOR) continue;
      const W = !mine(i - 1), E = !mine(i + 1), N = !mine(i - g.w), S = !mine(i + g.w);
      if ((W && E) || (N && S)) continue;
      let dir, mountType, where;
      if ((W || E) && (N || S)) { dir = Math.atan2(N ? 1 : -1, W ? 1 : -1); mountType = 'corner'; where = `${N ? 'north' : 'south'}-${W ? 'west' : 'east'}`; }
      else if (W || E || N || S) {
        if ((x + y) % (2 * step)) continue; // a wall position every couple of metres is enough
        dir = W ? 0 : E ? Math.PI : N ? Math.PI / 2 : -Math.PI / 2; mountType = 'wall'; where = W ? 'west' : E ? 'east' : N ? 'north' : 'south';
        // straight out from the wall, or angled 60 degrees along it (down a corridor)
        cands.push(...watch(i, [dir, dir + Math.PI / 3, dir - Math.PI / 3], mountType, where));
        continue;
      } else continue;
      cands.push(...watch(i, [dir], mountType, where));
    }
    // hung from the ceiling, looking four ways, in open areas over 6 m from any wall
    const dist = wallDistance(g), every = Math.max(1, Math.round(6 / g.c));
    for (let y = 0; y < g.h; y += every) for (let x = 0; x < g.w; x += every) {
      const i = y * g.w + x;
      if (mine(i) && dist[i] >= 6) cands.push(...watch(i, [0, Math.PI / 2, Math.PI, -Math.PI / 2], 'ceiling', null));
    }
    function watch(i, dirs, mountType, where) {
      const [px, py] = cx.centre(i);
      return dirs.map((dir) => {
        const covers = new Set();
        for (const sm of samples) {
          const [sx, sy] = cx.centre(sm.i), dd = Math.hypot(sx - px, sy - py);
          if (dd > C.range) continue;
          const off = Math.abs(((Math.atan2(sy - py, sx - px) - dir + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
          if ((off <= (C.fov / 2) * deg || dd < 0.6) && inSight(g, px, py, sx, sy)) covers.add(sm.id);
        }
        return { x: px, y: py, z, dir, mount: mountType, where, covers };
      }).filter((c) => c.covers.size);
    }
    const floorIds = samples.filter((sm) => !sm.door).map((sm) => sm.id), doorIds = samples.filter((sm) => sm.door).map((sm) => sm.id);
    const coverable = new Set(cands.flatMap((c) => [...c.covers]));
    const need = Math.min(floorIds.filter((f) => coverable.has(f)).length, Math.ceil(C.floorShare * floorIds.length));
    rooms.push({ zone, cands, floorIds, doorIds, need, chosen: [], floorOk: (set) => floorIds.filter((f) => set.has(f)).length >= need });
  }
  const best = (room, gainOf) => {
    let pick = null, ps = 0;
    for (const strict of [true, false]) {
      for (const c of room.cands) {
        if (strict && room.chosen.some((o) => facing(c, o))) continue;
        // corners first, as installers do, when they see about as much
        const score = gainOf(c) * (c.mount === 'corner' ? 1.08 : c.mount === 'ceiling' ? 0.85 : 1);
        if (score > ps) { ps = score; pick = c; }
      }
      if (pick) break;
    }
    return pick;
  };
  const coveredBy = (list) => new Set(list.flatMap((c) => [...c.covers]));
  // 1. each room's floor (doors count a little, so a camera that also sees one is preferred)
  for (const room of rooms) {
    const seen = new Set();
    while (!room.floorOk(seen)) {
      const c = best(room, (cand) => { let n = 0; for (const t of cand.covers) if (!seen.has(t)) n += t[0] === 'd' ? 0.5 : 1; return n; });
      if (!c) break;
      room.chosen.push(c);
      for (const t of c.covers) seen.add(t);
    }
  }
  // 2. any door no camera sees yet: a camera on whichever side sees the most of them
  const allDoors = new Set(rooms.flatMap((r) => r.doorIds));
  const doorsSeen = () => coveredBy(rooms.flatMap((r) => r.chosen));
  for (;;) {
    const seenNow = doorsSeen(), missing = [...allDoors].filter((d) => !seenNow.has(d));
    let pick = null, room = null, ps = 0;
    for (const r of rooms) {
      const c = best(r, (cand) => missing.filter((d) => cand.covers.has(d)).length);
      const n = c ? missing.filter((d) => c.covers.has(d)).length : 0;
      if (n > ps) { ps = n; pick = c; room = r; }
    }
    if (!pick) break;
    room.chosen.push(pick);
  }
  // 3. drop any camera the others make redundant (floor of its room, every door still seen)
  for (const room of rooms) for (let n = room.chosen.length - 1; n >= 0 && room.chosen.length > 1; n--) {
    const rest = room.chosen.filter((_, m) => m !== n);
    const before = doorsSeen(), others = coveredBy([...rooms.filter((r) => r !== room).flatMap((r) => r.chosen), ...rest]);
    if (room.floorOk(coveredBy(rest)) && [...allDoors].every((d) => !before.has(d) || others.has(d))) room.chosen = rest;
  }
  const out = [], summary = { floor: 0, floorAll: 0, rooms: {} };
  const everyone = rooms.flatMap((r) => r.chosen.map((c) => [r, c]));
  for (const room of rooms) {
    const { zone, floorIds, doorIds, chosen } = room, all = coveredBy(chosen);
    const door = (d) => site.doors.find((x) => x.id === d.slice(1));
    chosen.forEach((c, n) => {
      const byOthers = coveredBy(chosen.filter((o) => o !== c));
      const elsewhere = coveredBy(everyone.filter(([, o]) => o !== c).map(([, o]) => o));
      out.push({
        ...c, zone: zone.id, alone: chosen.length === 1, first: n === 0,
        share: floorIds.filter((f) => c.covers.has(f)).length / floorIds.length,
        own: floorIds.filter((f) => c.covers.has(f) && !byOthers.has(f)).length / floorIds.length,
        seesDoors: doorIds.filter((d) => c.covers.has(d)).map(door),
        ownDoors: doorIds.filter((d) => c.covers.has(d) && !elsewhere.has(d)).map(door),
      });
    });
    summary.floor += floorIds.filter((f) => all.has(f)).length; summary.floorAll += floorIds.length;
    summary.rooms[zone.id] = Math.round((floorIds.filter((f) => all.has(f)).length / floorIds.length) * 1000) / 1000;
  }
  const cameras = out.map((c, n) => ({
    id: `C${n + 1}`, x: round2(c.x), y: round2(c.y), z: round2(c.z), dir: round2(c.dir), fov: C.fov, range: C.range, zone: c.zone, mount: c.mount, where: c.where,
    doors: c.seesDoors.map((d) => d.id),
    reason: cameraReason(cx, c),
  }));
  // a door seen from either side is seen
  const unseen = (site.doors || []).filter((d) => (d.cells || []).length && !cameras.some((c) => c.doors.includes(d.id))).map((d) => d.id);
  return {
    cameras,
    floor_seen: summary.floorAll ? summary.floor / summary.floorAll : 1,
    doors_seen: (site.doors || []).length ? 1 - unseen.length / site.doors.length : 1,
    doors_unseen: unseen,
    rooms_seen: summary.rooms,
  };
}

function cameraReason(cx, c) {
  const room = cx.name(c.zone);
  const at = c.mount === 'corner' ? `${cap(c.where)} corner of ${room}, looking ${compass(c.dir)} across the room`
    : c.mount === 'ceiling' ? `Hung from the ceiling in the middle of ${room}, looking ${compass(c.dir)}, where no wall is close enough`
      : `On the ${c.where} wall of ${room}, looking ${compass(c.dir)}${compass(c.dir) === { west: 'east', east: 'west', north: 'south', south: 'north' }[c.where] ? '' : ' along the room'}`;
  const pct = (v) => (v > 0.995 ? 'all' : `${Math.round(v * 100)}%`);
  const list = (ds) => {
    const exits = ds.filter((d) => d.is_exit).map((d) => d.id), inner = ds.filter((d) => !d.is_exit).map((d) => d.id);
    return [exits.length && `exit${exits.length > 1 ? 's' : ''} ${exits.join(', ')}`, inner.length && `door${inner.length > 1 ? 's' : ''} ${inner.join(', ')}`].filter(Boolean).join(' and ');
  };
  if (c.alone) return `${at}: one camera sees ${pct(c.share)} of the room${c.seesDoors.length ? `, and ${list(c.seesDoors)}` : ''}.`;
  if (c.first) return `${at}: sees ${pct(c.share)} of the room${c.seesDoors.length ? ` and ${list(c.seesDoors)}` : ''}; the room is too big or too broken up for one camera.`;
  const adds = [c.own >= 0.01 && `the ${Math.round(c.own * 100)}% of the room the other cameras miss`, c.ownDoors.length && `${list(c.ownDoors)}, which no other camera sees`].filter(Boolean).join(', and ');
  return `${at}: covers ${adds || `${pct(c.share)} of the room`}.`;
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Every cell any camera sees: what the system can know about.
export function cameraView(site, cameras) {
  const g = prepare(site), seen = new Uint8Array(g.w * g.h);
  for (const cam of cameras) {
    const r = Math.ceil(cam.range / g.c), cx = Math.floor(cam.x / g.c), cy = Math.floor(cam.y / g.c);
    for (let y = Math.max(0, cy - r); y <= Math.min(g.h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(g.w - 1, cx + r); x++) {
      const i = y * g.w + x;
      if (seen[i] || g.kind[i] === K.WALL || g.kind[i] === K.OUTSIDE) continue;
      const px = (x + 0.5) * g.c, py = (y + 0.5) * g.c, d = Math.hypot(px - cam.x, py - cam.y);
      if (d > cam.range) continue;
      const off = Math.abs(((Math.atan2(py - cam.y, px - cam.x) - cam.dir + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      if ((off <= (cam.fov / 2) * deg || d < 0.6) && inSight(g, cam.x, cam.y, px, py)) seen[i] = 1;
    }
  }
  return seen;
}

// The whole plan: sign spots, projectors, cameras, and how well they cover the building.
export function equipmentPlan(site, opts = {}) {
  const targets = projectionTargets(site, opts);
  const { projectors, missed } = placeProjectors(site, targets, opts);
  const cams = placeCameras(site, opts);
  const owner = new Map();
  for (const p of projectors) for (const t of p.targets) owner.set(t, p.id);
  for (const t of targets) t.projector = owner.get(t.id) || null;
  return {
    targets, projectors, cameras: cams.cameras,
    coverage: { targets: targets.length ? (targets.length - missed.length) / targets.length : 1, targets_missed: missed, floor: cams.floor_seen, rooms: cams.rooms_seen, doors: cams.doors_seen, doors_unseen: cams.doors_unseen },
    params: { projector: PROJECTOR, camera: CAMERA, wallHeight: opts.wallHeight ?? 2.6 },
  };
}

// What the system knows at each moment: fire, fallen walls and jammed doors only where a camera
// sees them, CAMERA.delay seconds later (video detection). Smoke comes from the detectors.
export function perceivedHazard(hz, seen, delay = CAMERA.delay) {
  const mask = (a) => {
    if (!a) return a;
    const out = new Float32Array(a.length).fill(Infinity);
    for (let i = 0; i < a.length; i++) if (seen[i] && Number.isFinite(a[i])) out[i] = a[i] + delay;
    return out;
  };
  // a fire is known everywhere it has spread once a camera has seen any of it
  const fire = mask(hz.fireT);
  let first = Infinity;
  for (let i = 0; i < fire.length; i++) if (fire[i] < first) first = fire[i];
  const fireT = hz.fireT.map((v) => (Number.isFinite(v) ? Math.max(v, first) : Infinity));
  return { ...hz, fireT, rubbleT: mask(hz.rubbleT), blockT: mask(hz.blockT), seenAt: Number.isFinite(first) ? first : null };
}

// What each sign spot shows at time t, from what the system knows (result: with the perceived
// hazard). show null: off. Projectors switch on when the alarm is raised or a camera sees the
// fire; in an earthquake they say TAKE COVER while the ground shakes, then point the way out.
export function signScene(plan, site, result, t) {
  const hz = result.hazard, quake = !!result.quake;
  const on = quake ? 0 : Math.min(result.fireModel?.alarm ?? Infinity, hz.seenAt ?? Infinity, result.fireModel?.warned ?? Infinity);
  if (!(t >= on)) return plan.targets.map((s) => ({ id: s.id, show: null }));
  const shaking = quake && quakeProjectionShaking(result, t);
  const allowed = result.metrics.exits.map((e) => e.id);
  const g = prepare({ ...site, evacuationExitIds: allowed }), field = new Float64Array(g.w * g.h).fill(Infinity);
  if (!shaking) routeField(g, hz, t, field, undefined, (i) => [1, 3, 4].includes(g.kind[i]) && projectionCellClear(result, i, t), null, 0.1);
  const cell = (x, y) => Math.min(g.h - 1, Math.max(0, Math.floor(y / g.c))) * g.w + Math.min(g.w - 1, Math.max(0, Math.floor(x / g.c)));
  const walk = (i, metres) => descend(g, field, i, metres);
  const doorOf = new Map(site.doors.map((d) => [d.id, d]));
  return plan.targets.map((s) => {
    if (s.kind === 'training') return { id: s.id, show: 'training' };
    if (shaking) return { id: s.id, show: s.surface === 'floor' ? 'cover' : null };
    const d = s.door ? doorOf.get(s.door) : null;
    if (s.kind === 'lintel') return { id: s.id, show: projectionDoorKind(d, site, result, t) };
    const i = cell(s.x, s.y);
    const path = Number.isFinite(field[i]) ? walk(i, 3) : [i];
    // standing in smoke, or cut off: warn rather than say nothing
    const danger = smokeAt(hz, i, t) >= 0.1 ? 'smoke' : !Number.isFinite(field[i]) ? 'blocked' : null;
    const ahead = path[Math.min(path.length - 1, Math.max(1, Math.round(1 / g.c)))];
    const dir = [((ahead % g.w) + 0.5) * g.c - s.x, (Math.floor(ahead / g.w) + 0.5) * g.c - s.y];
    if (s.kind === 'door-sign') {
      const kind = projectionDoorKind(d, site, result, t);
      if (kind && kind !== 'exit') return { id: s.id, show: kind };
      // the way out goes through this door: point at it (EXIT at an exit); else nothing here
      const through = path.some((j) => g.doorOf[j] >= 0 && g.doors[g.doorOf[j]].id === d.id);
      if (!through) return { id: s.id, show: danger };
      return kind === 'exit' ? { id: s.id, show: 'exit' } : { id: s.id, show: 'arrow', dir: [d.x - s.x, d.y - s.y] };
    }
    // no safe way out from here: say the route is blocked rather than point anywhere
    return path.length > 1 ? { id: s.id, show: 'arrow', dir } : { id: s.id, show: danger };
  });
}

// Which projector shows each sign on show (meshes or drawings with a position).
export function assignSigns(plan, signs) {
  const out = [];
  for (const s of signs) {
    let best = null, bd = 1.6;
    for (const t of plan.targets) {
      if (t.surface !== (s.surface || 'floor') || !t.projector) continue;
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      if (d < bd) { bd = d; best = t; }
    }
    out.push({ ...s, target: best?.id || null, projector: best?.projector || null });
  }
  return out;
}

const round2 = (v) => Math.round(v * 100) / 100;
