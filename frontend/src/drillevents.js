import { prepare, nearestWalkable, routeField, smokeAt } from './sim.js';

// Simulation facts only: no company names, procedures or model-derived hazards.
export function drillEvents(result, site) {
  if (result.quake) return quakeEvents(result, site);
  if (result.hazard?.kind === 'zone') return zoneEvents(result, site);
  const { grid, zones, doors } = site, hz = result.hazard;
  const events = [];
  const room = (id) => { const z = zones.find((z) => z.id === id); return z ? `${z.name} (${z.id})` : id; };
  const add = (time, id, scenario, zoneId, fact, doorId = null) => {
    if (Number.isFinite(time)) events.push({
      time: Math.max(0, time), id, scenario, zoneId, fact,
      zoneIds: !doorId && zoneId ? [zoneId] : [], doorIds: doorId ? [doorId] : [],
    });
  };
  const origin = result.fire.zone;
  add(0, 'alarm', 'alarm', origin, `Fire starts in ${origin ? room(origin) : `the picked floor cell ${result.fire.cell}`}.`);
  const floor = new Map(zones.map((z) => [Number(z.id.slice(1)), []]));
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
    if (grid.cells[y][x] === '.') floor.get(grid.zone_ids[y][x])?.push(y * grid.w + x);
  }
  for (const z of zones) {
    const cells = floor.get(Number(z.id.slice(1))) || [];
    let fire = Infinity;
    const smoke = [];
    for (const i of cells) {
      fire = Math.min(fire, hz.fireT[i]);
      smoke.push(hz.smokeT[i] + hz.tau[i] * Math.LN2);
    }
    if (z.id !== origin) add(fire, `fire:${z.id}`, 'alarm', z.id, `Fire reaches part of ${room(z.id)}.`);
    // Same room-level threshold as sim.js summarise(), without its rounded timestamps.
    smoke.sort((a, b) => a - b);
    add(smoke[Math.floor(smoke.length / 2)], `smoke:${z.id}`, 'smoke', z.id,
      `Thick smoke covers at least half the floor of ${room(z.id)}.`);
  }
  for (const d of doors) {
    const cells = (d.cells || []).filter(([x, y]) => x >= 0 && y >= 0 && x < grid.w && y < grid.h
      && ['D', 'E'].includes(grid.cells[y][x]));
    if (!cells.length) continue;
    // routeField blocks a walkable cell iff fireT[i] <= t + 2. Smoke raises cost;
    // queues do not block navigation. A wide door is blocked only once ALL its cells are.
    const time = Math.max(...cells.map(([x, y]) => hz.fireT[y * grid.w + x] - 2));
    const ends = (d.connects || []).map((id) => id === 'outside' ? 'outside' : room(id)).join(' / ');
    add(time, `door:${d.id}`, 'blocked_route', (d.connects || []).find((id) => zones.some((z) => z.id === id)),
      `${d.is_exit ? 'Exit' : 'Door'} ${d.id}${ends ? ` (${ends})` : ''} is blocked in navigation by fire proximity.`, d.id);
  }
  events.sort((a, b) => a.time - b.time || (a.id === 'alarm' ? -1 : b.id === 'alarm' ? 1 : a.id.localeCompare(b.id)));
  return events;
}

// Fire facts from the two-zone model: detection, warning, sprinkler, flashover, and for each
// room when smoke comes below head height and when it stops being tenable. Scenarios match the
// source-backed actions: 'alarm', 'smoke', 'blocked_route'.
function zoneEvents(result, site) {
  const hz = result.hazard, fm = result.fireModel || {}, events = [];
  const room = (id) => { const z = site.zones.find((z) => z.id === id); return z ? `${z.name} (${z.id})` : id; };
  const add = (time, id, scenario, zoneId, fact, doorId = null) => {
    if (Number.isFinite(time)) events.push({ time: Math.max(0, time), id, scenario, zoneId, fact, zoneIds: !doorId && zoneId ? [zoneId] : [], doorIds: doorId ? [doorId] : [] });
  };
  const origin = result.fire?.zone;
  const kw = (t) => Math.round(hz.zone.Q[Math.max(0, Math.min(hz.zone.Q.length - 1, Math.floor(t)))]);
  add(0, 'alarm', 'alarm', origin, `Fire starts in ${origin ? room(origin) : 'the picked spot'} (design fire, growing as t²).`);
  const how = { smoke: 'Smoke detectors', heat: 'Heat detectors', none: 'Someone' }[hz.zone.opts.detection] || 'Detectors';
  if (fm.alarm != null) add(fm.alarm, 'detected', 'alarm', origin, `${fm.sprinkler === fm.alarm ? 'A sprinkler flow switch' : how} raise${how === 'Someone' ? 's' : ''} the alarm: the fire is about ${kw(fm.alarm)} kW.`);
  if (fm.warned != null && Number.isFinite(fm.warned)) add(fm.warned, 'warned', 'alarm', origin, 'The alarm sounds through the building: everyone is warned.');
  if (fm.sprinkler != null) add(fm.sprinkler, 'sprinkler', 'alarm', origin, `A sprinkler opens above the fire and holds it at about ${kw(fm.sprinkler)} kW.`);
  if (fm.flashover != null) add(fm.flashover, 'flashover', 'blocked_route', origin, `Flashover in ${room(origin)}: the whole room is on fire.`);
  const why = { visibility: 'smoke too thick to see 10 m', 'toxic gases': 'toxic gas dose over the limit', heat: 'heat dose over the limit', 'radiant heat': 'radiant heat from the smoke layer', flashover: 'flashover' };
  (fm.aset || hz.aset || []).forEach((a, k) => {
    const id = site.zones[k]?.id;
    if (!id) return;
    if (a.layerBelow2m != null) add(a.layerBelow2m, `smoke:${id}`, 'smoke', id, `Smoke comes down below head height (2 m) in ${room(id)}.`);
    if (a.aset != null) add(a.aset, `untenable:${id}`, 'smoke', id, `${room(id)} is no longer tenable: ${why[a.cause] || a.cause}.`);
  });
  const { grid } = site;
  for (const d of site.doors) {
    const cells = (d.cells || []).filter(([x, y]) => x >= 0 && y >= 0 && x < grid.w && y < grid.h && ['D', 'E'].includes(grid.cells[y][x]));
    if (!cells.length) continue;
    const time = Math.max(...cells.map(([x, y]) => hz.fireT[y * grid.w + x] - 2));
    const ends = (d.connects || []).map((id) => (id === 'outside' ? 'outside' : room(id))).join(' / ');
    add(time, `door:${d.id}`, 'blocked_route', (d.connects || []).find((id) => site.zones.some((z) => z.id === id)), `${d.is_exit ? 'Exit' : 'Door'} ${d.id}${ends ? ` (${ends})` : ''} is cut off by the fire.`, d.id);
  }
  events.sort((a, b) => a.time - b.time || (a.id === 'alarm' ? -1 : b.id === 'alarm' ? 1 : a.id.localeCompare(b.id)));
  return events;
}

// Earthquake facts: the shaking, each wall that comes down, jammed doors, toppled furniture.
// Scenario 'earthquake': no source-backed actions exist for it yet, so the subtitle keeps the
// general instruction to follow official alarms and responders.
function quakeEvents(result, site) {
  const q = result.quake, events = [];
  const room = (id) => { const z = site.zones.find((z) => z.id === id); return z ? `${z.name} (${z.id})` : id; };
  const rooms = (ids) => ids.map(room).join(' and ');
  const add = (time, id, fact, zoneIds = [], doorIds = []) => events.push({ time, id, scenario: 'earthquake', zoneId: zoneIds[0] || null, fact, zoneIds, doorIds });
  add(0, 'alarm', `${q.label} earthquake: the ground shakes for about ${q.duration} s (peak ${q.pga.toFixed(2)} g).`);
  add(q.duration, 'shake-end', 'The shaking stops. People who took cover start to leave.');
  if (q.aftershock) add(q.aftershock.t, 'aftershock', `Aftershock (peak ${q.aftershock.pga.toFixed(2)} g) while people are leaving.`);
  for (const e of q.events) {
    if (e.type === 'wall') add(e.t, `wall:${e.id}`, `A wall collapses${e.zones.length ? ` in ${rooms(e.zones)}` : ''}. Rubble blocks part of the floor.`, e.zones);
    else if (e.type === 'door') {
      const d = site.doors.find((x) => x.id === e.id);
      add(e.t, `door:${e.id}`, `${d?.is_exit ? 'Exit' : 'Door'} ${e.id} is jammed shut by the shaking.`, [], [e.id]);
    } else if (e.type === 'topple') add(e.t, `topple:${e.id}`, `Tall furniture overturns${e.zones.length ? ` in ${rooms(e.zones)}` : ''}.`, e.zones);
  }
  events.sort((a, b) => a.time - b.time || (a.id === 'alarm' ? -1 : b.id === 'alarm' ? 1 : a.id.localeCompare(b.id)));
  return events;
}

// Hold a subtitle for five simulation seconds; coalesce intervening events rather
// than build a stale backlog. Recompute from time so backwards seeks are identical.
export function eventAt(events, t) {
  let current = null, shownAt = -Infinity, i = 0;
  while (i < events.length) {
    const nextAt = Math.max(events[i].time, shownAt + 5);
    if (nextAt > t) break;
    const batch = [];
    while (i < events.length && events[i].time <= nextAt) batch.push(events[i++]);
    current = batch.find((e) => e.id === 'alarm')
      || batch.findLast((e) => e.scenario === 'blocked_route') || batch[batch.length - 1];
    shownAt = nextAt;
  }
  return current;
}

export function projectionDoorKind(d, site, result, t) {
  const hz=result.hazard, n=site.grid.w*site.grid.h;
  const cells=(d.cells||[]).filter(([x,y])=>x>=0&&y>=0&&x<site.grid.w&&y<site.grid.h).map(([x,y])=>y*site.grid.w+x);
  if(d.is_exit && !result.metrics.exits.some(e=>e.id===d.id)) return 'excluded';
  if(!cells.length || !n) return null;
  if(cells.every(i=>hz.fireT[i]<=t+2)) return 'blocked';
  if(cells.some(i=>smokeAt(hz,i,t)>=0.1)) return 'smoke';
  return d.is_exit ? 'exit' : null;
}

// Projection concepts use current simulation hazards, never model output or future frames.
export function projectionPlan(site, result, t) {
  const allowed = result.metrics.exits.map(e => e.id);
  const g = prepare({ ...site, evacuationExitIds: allowed });
  const hz = result.hazard, field = new Float64Array(g.w * g.h);
  // A conservative demo threshold, not a physical visibility or tenability standard.
  routeField(g, hz, t, field, undefined, undefined, null, 0.1);
  const point = i => [((i % g.w) + 0.5) * g.c, (Math.floor(i / g.w) + 0.5) * g.c];
  const arrows = [], signs = [], anchors = [];
  const floorNear = (x, y) => nearestWalkable(g, x, y);
  for (const d of site.doors) {
    const kind = projectionDoorKind(d, site, result, t);
    for (const id of d.connects || []) {
      const z = site.zones.find(z => z.id === id);
      if (!z) continue;
      const vx=z.centroid[0]-d.x, vy=z.centroid[1]-d.y, len=Math.hypot(vx,vy)||1;
      const i=floorNear(d.x+vx/len*1.4,d.y+vy/len*1.4);
      if (i < 0 || g.zone[i] !== Number(id.slice(1))) continue;
      signs.push({id:d.id,kind,x:point(i)[0],y:point(i)[1]});
      // Keep arrows separate from projected doorway messages.
      const a=floorNear(d.x+vx/len*3.2,d.y+vy/len*3.2);
      if (a>=0 && g.zone[a]===Number(id.slice(1))) anchors.push(a);
    }
  }
  for (const z of site.zones) {
    const i=floorNear(...z.centroid);
    if (i>=0) anchors.push(i);
  }
  for (const start of new Set(anchors)) {
    if (!Number.isFinite(field[start])) continue;
    const p=point(start);
    if (arrows.some(a => Math.hypot(a.x-p[0],a.y-p[1]) < 2.5)
      || signs.some(s => Math.hypot(s.x-p[0],s.y-p[1]) < 1.5)) continue;
    const path=[start]; let i=start;
    while (g.kind[i]!==4 && path.length<=field.length) {
      const x=i%g.w,y=Math.floor(i/g.w); let next=-1,best=field[i];
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
        const nx=x+dx,ny=y+dy,j=ny*g.w+nx;
        if(nx<0||ny<0||nx>=g.w||ny>=g.h||field[j]>=best) continue;
        if(dx&&dy&&(!Number.isFinite(field[y*g.w+nx])||!Number.isFinite(field[ny*g.w+x]))) continue;
        next=j;best=field[j];
      }
      if(next<0) break;
      path.push(next);i=next;
    }
    if(g.kind[i]!==4 || path.length<2) continue;
    const q=point(path[Math.min(path.length-1,Math.max(1,Math.round(1/g.c)))]);
    const guards=new Set(path);
    for(let k=1;k<path.length;k++) {
      const i=path[k-1],j=path[k],x=i%g.w,y=Math.floor(i/g.w),nx=j%g.w,ny=Math.floor(j/g.w);
      if(x!==nx&&y!==ny) {guards.add(y*g.w+nx);guards.add(ny*g.w+x);}
    }
    arrows.push({x:p[0],y:p[1],dx:q[0]-p[0],dy:q[1]-p[1],path,guards:[...guards]});
  }
  return {arrows,signs};
}
