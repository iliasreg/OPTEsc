// Simulation facts only: no company names, procedures or model-derived hazards.
export function drillEvents(result, site) {
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
