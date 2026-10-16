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
  const room = (id) => site.zones.find((z) => z.id === id)?.name || id;
  const add = (time, id, scenario, zoneId, fact, doorId = null) => {
    if (Number.isFinite(time)) events.push({ time: Math.max(0, time), id, scenario, zoneId, fact, zoneIds: !doorId && zoneId ? [zoneId] : [], doorIds: doorId ? [doorId] : [] });
  };
  const origin = result.fire?.zone;
  add(0, 'alarm', 'alarm', origin, `A fire starts in ${origin ? room(origin) : 'the building'}. Nobody has noticed yet.`);
  if (fm.alarm != null) {
    const how = fm.sprinkler === fm.alarm ? 'The sprinkler system sets off the alarm.'
      : { smoke: 'The smoke detectors go off.', heat: 'The heat detectors go off.', none: 'Someone sees the fire and raises the alarm.' }[hz.zone.opts.detection] || 'The fire is detected.';
    add(fm.alarm, 'detected', 'alarm', origin, how);
  }
  if (fm.warned != null && Number.isFinite(fm.warned)) add(fm.warned, 'warned', 'alarm', origin, 'The alarm rings through the building. People stop, look around, and start to leave.');
  const m = result.metrics || {};
  if (m.all_out_s != null) add(m.all_out_s, 'all-out', 'alarm', null, `Everyone is out: ${m.people} people in ${clock(m.all_out_s)}.`);
  if (fm.sprinkler != null) add(fm.sprinkler, 'sprinkler', 'alarm', origin, 'A sprinkler opens above the fire and stops it from growing.');
  if (fm.flashover != null) add(fm.flashover, 'flashover', 'blocked_route', origin, `All of ${room(origin)} is now on fire.`);
  const why = { visibility: 'the smoke is too thick to see the way out', 'toxic gases': 'the smoke is poisonous to breathe', heat: 'it is too hot', 'radiant heat': 'the heat from the smoke above is too strong', flashover: 'it is on fire' };
  (fm.aset || hz.aset || []).forEach((a, k) => {
    const id = site.zones[k]?.id;
    if (!id) return;
    if (a.layerBelow2m != null) add(a.layerBelow2m, `smoke:${id}`, 'smoke', id, `Smoke in ${room(id)} comes down to head height.`);
    if (a.aset != null) add(a.aset, `untenable:${id}`, 'smoke', id, `${room(id)} is now too dangerous to be in: ${why[a.cause] || a.cause}.`);
  });
  const { grid } = site;
  for (const d of site.doors) {
    const cells = (d.cells || []).filter(([x, y]) => x >= 0 && y >= 0 && x < grid.w && y < grid.h && ['D', 'E'].includes(grid.cells[y][x]));
    if (!cells.length) continue;
    const time = Math.max(...cells.map(([x, y]) => hz.fireT[y * grid.w + x] - 2));
    add(time, `door:${d.id}`, 'blocked_route', (d.connects || []).find((id) => site.zones.some((z) => z.id === id)), `The fire blocks ${doorLabel(d, room)}.`, d.id);
  }
  events.sort((a, b) => a.time - b.time || (a.id === 'alarm' ? -1 : b.id === 'alarm' ? 1 : a.id.localeCompare(b.id)));
  return events;
}

const clock = (s) => { const r = Math.round(s); return r < 60 ? `${r} seconds` : `${Math.floor(r / 60)} min ${String(r % 60).padStart(2, '0')} s`; };
// "the exit from the canteen (D9)", "the door between the office and the corridor (D4)"
function doorLabel(d, room) {
  const ends = (d.connects || []).filter((id) => id !== 'outside').map(room);
  return d.is_exit ? `the exit from ${ends[0] || 'the building'} (${d.id})` : ends.length > 1 ? `the door between ${ends.join(' and ')} (${d.id})` : `door ${d.id}`;
}

// Earthquake facts: the shaking, each wall that comes down and who it lands on, jammed doors,
// toppled furniture. Phase changes bypass subtitle holds so renewed shaking cannot retain
// evacuation guidance.
function quakeEvents(result, site) {
  const q = result.quake, events = [];
  const room = (id) => site.zones.find((z) => z.id === id)?.name || id;
  const rooms = (ids) => ids.map(room).join(' and ');
  const phaseAt = time => q.aftershock && time >= q.aftershock.t && time < q.aftershock.t + q.aftershock.duration*1.3
    ? 'earthquake_aftershock' : time < q.duration*1.3 ? 'earthquake' : 'earthquake_after';
  const add = (time, id, fact, zoneIds = [], doorIds = [], quakePhase = false) => events.push({ time, id, scenario: phaseAt(time), zoneId: zoneIds[0] || site.zones[0]?.id || null, fact, zoneIds, doorIds, quakePhase });
  const strength = { moderate: 'A light', strong: 'A strong', severe: 'A very strong', extreme: 'An extreme' }[q.level] || `A ${String(q.label || '').toLowerCase()}`;
  add(0, 'alarm', `${strength} earthquake: the ground shakes for about ${q.duration} seconds. Most people drop, take cover and hold on.`, [], [], true);
  add(q.duration*1.3, 'shake-end', 'The shaking stops. People who took cover get up and leave. The building may still be unsafe.', [], [], true);
  if (q.aftershock) {
    add(q.aftershock.t, 'aftershock', 'An aftershock shakes the building again while people are leaving.', [], [], true);
    add(q.aftershock.t+q.aftershock.duration*1.3, 'aftershock-end', 'The aftershock is over. More shocks and falling debris are still possible.', [], [], true);
  }
  const where = (e) => (e.zones.length ? ` in ${rooms(e.zones)}` : '');
  const hitBy = new Map((q.hits || []).map((h) => [`${h.type}:${h.id}`, h]));
  const caught = (h) => {
    if (!h) return '';
    const who = h.people === 1 ? 'someone' : `${h.people} people`;
    if (!h.killed) return ` It falls on ${who}.`;
    if (h.people === 1) return ' It falls on someone, who does not survive.';
    return ` It falls on ${who}; ${h.killed === h.people ? 'none of them survive' : `${h.killed} of them do not survive`}.`;
  };
  for (const e of q.events) {
    if (e.type === 'wall') add(e.t, `wall:${e.id}`, `A wall collapses${where(e)}.${caught(hitBy.get(`wall:${e.id}`))}`, e.zones);
    else if (e.type === 'door') {
      const d = site.doors.find((x) => x.id === e.id);
      add(e.t, `door:${e.id}`, `The shaking jams ${d ? doorLabel(d, room) : `door ${e.id}`}. It will not open.`, [], [e.id]);
    } else if (e.type === 'topple') add(e.t, `topple:${e.id}`, `A tall cupboard or shelf falls over${where(e)}.${caught(hitBy.get(`topple:${e.id}`))}`, e.zones);
  }
  const m = result.metrics || {};
  if (m.all_out_s != null) add(m.all_out_s, 'all-out', `Everyone is out: ${m.people} people in ${clock(m.all_out_s)}.`);
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
  const phase=events.findLast(e=>e.quakePhase&&e.time<=t);
  return phase && current?.scenario!==phase.scenario ? phase : current;
}

export function projectionCellClear(result, i, t) {
  const hz=result.hazard;
  return hz.fireT[i]>t+2 && smokeAt(hz,i,t)<0.1
    && !(hz.blockT?.[i]<=t) && !(hz.rubbleT?.[i]<=t);
}

export function quakeProjectionShaking(result, t) {
  const q=result.quake;
  return !!q && (t<q.duration*1.3 || !!q.aftershock && t>=q.aftershock.t && t<q.aftershock.t+q.aftershock.duration*1.3);
}

export function projectionDoorKind(d, site, result, t) {
  const hz=result.hazard, n=site.grid.w*site.grid.h;
  const cells=(d.cells||[]).filter(([x,y])=>x>=0&&y>=0&&x<site.grid.w&&y<site.grid.h).map(([x,y])=>y*site.grid.w+x);
  if(d.is_exit && !result.metrics.exits.some(e=>e.id===d.id)) return 'excluded';
  if(!cells.length || !n) return null;
  if(cells.every(i=>hz.fireT[i]<=t+2 || hz.blockT?.[i]<=t || hz.rubbleT?.[i]<=t)) return 'blocked';
  if(cells.some(i=>smokeAt(hz,i,t)>=0.1)) return 'smoke';
  return d.is_exit ? 'exit' : null;
}

// Projection concepts use current simulation hazards, never model output or future frames.
export function projectionPlan(site, result, t) {
  const allowed = result.metrics.exits.map(e => e.id);
  const g = prepare({ ...site, evacuationExitIds: allowed });
  const hz = result.hazard, field = new Float64Array(g.w * g.h);
  // A conservative demo threshold, not a physical visibility or tenability standard.
  if(quakeProjectionShaking(result,t)) field.fill(Infinity);
  else routeField(g, hz, t, field, undefined,
    i=>[1,3,4].includes(g.kind[i])&&projectionCellClear(result,i,t),null,0.1);
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
