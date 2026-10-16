// Two-zone fire and smoke model for an OPTEsc site: each room has a hot smoke layer under the
// ceiling over cool air. Pure module (page, worker, Node).
//
// Design fire (NZ Verification Method C/VM2, Table 2.1): t-squared growth, fast by default
// (0.0469 t^2 kW), peak 20 MW, 250 kW/m2 for the fire area in a zone model, radiative fraction
// 0.35, heat of combustion 20 MJ/kg, soot yield 0.07 and CO yield 0.04 kg/kg (post-flashover
// 0.14 and 0.40). Flashover when the layer reaches 500 C, then the fire is limited by its
// ventilation (Kawagoe, 1500 A sqrt(H) kW). With sprinklers the fire is held at the heat
// release rate it had when the first sprinkler opened (C/VM2 2.3.1).
//
// Smoke: the fire plume (Heskestad) carries air and combustion products into the layer of the
// room of origin; the layer deepens; once it is below a door soffit it spills into the next
// room through open doors and openings (orifice flow driven by the layer's buoyancy, discharge
// coefficient 0.7). Exit doors and windows stay closed. A share of the convective heat goes into
// walls and ceiling (heat loss fraction, 0.7 by default; 0.6-0.9 is the usual range).
// Simplifications to keep in mind: no entrainment in the spill plumes, no leakage, no mixing
// at vents, no layer cooling after the fire is controlled.
//
// Detection (C/VM2 Table 3.2): smoke detectors alarm at an optical density of 0.097 /m in the
// room of origin; heat detectors (RTI 30, 57 C, 4.2 m away) and sprinklers (quick response
// RTI 50, C 0.65, 68 C, 3.25 m; standard RTI 135, C 0.85) heat up in the ceiling jet (Alpert)
// following Heskestad and Bill's model with conduction losses. Notification follows 30 s later.
//
// Tenability at 2.0 m above the floor (NZBC C4.3 via C/VM2 4.x): visibility of at least 10 m
// (5 m in rooms under 100 m2), FED for CO and for heat each no more than 0.3. Visibility from
// the soot in the layer: extinction = 8700 m2/kg x soot density, visibility = 3 / extinction
// (light-reflecting signs). FED for CO (ISO 13571): CO ppm x minutes / 35 000, with the CO2
// hyperventilation factor exp(0.1903 %CO2 + 2.0004) / 7.1. FED for convected heat (ISO 13571):
// minutes / (5e7 T^-3.4), T in C. Radiant heat from the layer above, taken as a black body:
// 2.5 kW/m2 (reached at about 180-200 C) is the limit of tolerable skin pain.

export const FIRE_DEFAULTS = {
  growth: 'fast', // FIRE_GROWTH
  peakKW: 20000,
  hrrpua: 250, // kW/m2, fire area in a zone model
  chiRad: 0.35,
  heatOfCombustion: 20000, // kJ/kg
  ySoot: 0.07, yCO: 0.04, yCO2: 1.5,
  ySootPost: 0.14, yCOPost: 0.4,
  lossFraction: 0.7, // share of convective heat lost to the boundaries
  ceiling: 3.0, // m, room height
  doorHeight: 2.0, // m, door soffit
  interiorDoors: 'open', // 'open' or 'closed'
  detection: 'smoke', // 'smoke', 'heat' or 'none'
  sprinklers: 'none', // 'none', 'quick', 'standard'
  notification: 30, // s from detection to warning the occupants (C/VM2 3.2.2)
  dt: 0.5,
  maxTime: 1800,
  ambient: 293.15, // K
};

// t-squared growth coefficients, kW/s2 (NFPA 72 / SFPE): C/VM2 uses fast for most buildings and
// 0.188 (ultra-fast) for storage stacked 3 to 5 m high.
export const FIRE_GROWTH = { slow: 0.00293, medium: 0.01172, fast: 0.0469, ultrafast: 0.1876 };

export const TENABILITY = { fed: 0.3, visibility: 10, visibilitySmall: 5, smallRoom: 100, radiant: 2.5, height: 2.0 };
const KM = 8700; // m2/kg, mass specific extinction of soot
const CP = 1.0; // kJ/kg K
const G = 9.81;
const SIGMA = 5.67e-11; // kW/m2 K4
const SPRINKLER = { quick: { rti: 50, c: 0.65, tact: 68, r: 3.25 }, standard: { rti: 135, c: 0.85, tact: 68, r: 3.25 } };
const HEAT_DETECTOR = { rti: 30, c: 0, tact: 57, r: 4.2 };

// The room network of a site: rooms (zones) with floor area, and vents between them.
export function roomNetwork(site, opts = {}) {
  const o = { ...FIRE_DEFAULTS, ...opts };
  const index = new Map(site.zones.map((z, k) => [z.id, k]));
  const rooms = site.zones.map((z) => ({ id: z.id, area: Math.max(1, z.area_m2 || z.grid_area_m2 || 10), height: o.ceiling }));
  const vents = [];
  for (const d of site.doors || []) {
    const [a, b] = (d.connects || []).map((c) => (c === 'outside' ? -1 : index.get(c) ?? -1));
    if (a == null || b == null) continue;
    const exterior = a < 0 || b < 0;
    // exit doors stay shut; an interior door is open or closed for the whole run
    const open = !exterior && o.interiorDoors === 'open';
    vents.push({ id: d.id, a: exterior ? Math.max(a, b) : a, b: exterior ? -1 : b, width: Math.max(0.5, d.width_m || 0.9), soffit: Math.min(o.doorHeight, o.ceiling), open, exterior });
  }
  for (const op of site.openings || []) {
    const [a, b] = op.between.map((id) => index.get(id));
    if (a == null || b == null) continue;
    // an opening with no wall or door above: smoke flows freely under the ceiling
    vents.push({ id: `${op.between.join('-')}`, a, b, width: Math.max(0.5, op.length_m || 1), soffit: o.ceiling, open: true, exterior: false });
  }
  return { rooms, vents, index };
}

// Ceiling jet temperature rise (K) and velocity (m/s) r metres from the plume axis under a
// ceiling H metres above the fire (Alpert 1972).
export function ceilingJet(Q, H, r) {
  if (Q <= 0) return { dT: 0, u: 0 };
  const dT = r / H <= 0.18 ? (16.9 * Q ** (2 / 3)) / H ** (5 / 3) : (5.38 * (Q / r) ** (2 / 3)) / H;
  const u = r / H <= 0.15 ? 0.96 * (Q / H) ** (1 / 3) : (0.195 * Q ** (1 / 3) * H ** 0.5) / r ** (5 / 6);
  return { dT, u };
}

// Plume mass flow (kg/s) at height z above the fire base (Heskestad).
export function plumeMass(Q, z, hrrpua = 250, chiRad = 0.35) {
  if (Q <= 0 || z <= 0) return 0;
  const Qc = (1 - chiRad) * Q;
  const D = Math.sqrt((4 * (Q / hrrpua)) / Math.PI);
  const L = Math.max(0.05, 0.235 * Q ** 0.4 - 1.02 * D);
  if (z <= L) return (0.0056 * Qc * z) / L;
  return 0.071 * Qc ** (1 / 3) * z ** (5 / 3) + 0.0018 * Qc;
}

// Run the zone model for a fire in room `origin` (index). Returns time series per room at
// 1 s steps and the key times (alarm, sprinkler, flashover).
export function zoneFire(net, origin, opts = {}) {
  const o = { ...FIRE_DEFAULTS, ...opts };
  const alpha = FIRE_GROWTH[o.growth] ?? FIRE_GROWTH.fast;
  const Ta = o.ambient, rhoA = 353 / Ta;
  const n = net.rooms.length;
  const m = new Float64Array(n), hs = new Float64Array(n), soot = new Float64Array(n), co = new Float64Array(n), co2 = new Float64Array(n);
  const steps = Math.ceil(o.maxTime);
  const out = {
    t: steps + 1,
    zi: Array.from({ length: n }, () => new Float32Array(steps + 1)),
    T: Array.from({ length: n }, () => new Float32Array(steps + 1)),
    soot: Array.from({ length: n }, () => new Float32Array(steps + 1)),
    co: Array.from({ length: n }, () => new Float32Array(steps + 1)), // ppm
    co2: Array.from({ length: n }, () => new Float32Array(steps + 1)), // %
    Q: new Float32Array(steps + 1),
  };
  // room-of-origin vents (for the ventilation limit after flashover)
  const ventArea = net.vents.filter((v) => v.a === origin || v.b === origin).reduce((s, v) => s + v.width * v.soffit * Math.sqrt(v.soffit), 0);
  const qVent = 1500 * Math.max(ventArea, 0.9 * 2.0 * Math.sqrt(2.0));
  const det = o.detection === 'heat' ? HEAT_DETECTOR : null, spr = SPRINKLER[o.sprinklers] || null;
  let tDet = det ? Ta - 273.15 : 0, tSpr = spr ? Ta - 273.15 : 0;
  let alarm = null, sprinklerAt = null, flashoverAt = null, qHeld = null;
  const layer = (k) => {
    if (m[k] <= 0) return { zi: net.rooms[k].height, T: Ta, rho: rhoA };
    const T = Ta + hs[k] / (CP * m[k]);
    const rho = 353 / T;
    const d = Math.min(net.rooms[k].height, m[k] / rho / net.rooms[k].area);
    return { zi: net.rooms[k].height - d, T, rho };
  };
  const record = (s, Q) => {
    out.Q[s] = Q;
    for (let k = 0; k < n; k++) {
      const L = layer(k);
      out.zi[k][s] = L.zi; out.T[k][s] = L.T;
      const V = m[k] > 0 ? m[k] / L.rho : 1;
      out.soot[k][s] = m[k] > 0 ? soot[k] / V : 0;
      out.co[k][s] = m[k] > 0 ? (co[k] / 28 / (m[k] / 28.95)) * 1e6 : 0;
      out.co2[k][s] = m[k] > 0 ? (co2[k] / 44 / (m[k] / 28.95)) * 100 : 0;
    }
  };
  record(0, 0);
  let nextRec = 1;
  for (let t = o.dt; t <= o.maxTime + 1e-9; t += o.dt) {
    // heat release rate now
    let Q = Math.min(o.peakKW, alpha * t * t);
    if (qHeld != null) Q = Math.min(Q, qHeld);
    if (flashoverAt != null) Q = Math.min(o.peakKW, qVent);
    const post = flashoverAt != null;
    const L0 = layer(origin);
    // plume into the layer of the room of origin, plus what burns
    const mf = Q / o.heatOfCombustion;
    const mp = plumeMass(Q, L0.zi, o.hrrpua, o.chiRad);
    m[origin] += (mp + mf) * o.dt;
    // once sprinklers spray, the water takes up most of the heat (C/VM2: a sprinkler-controlled
    // fire does not flash over); taken here as 90% lost instead of the usual share
    const loss = sprinklerAt != null ? Math.max(o.lossFraction, 0.9) : o.lossFraction;
    hs[origin] += (1 - loss) * (1 - o.chiRad) * Q * o.dt;
    soot[origin] += mf * (post ? o.ySootPost : o.ySoot) * o.dt;
    co[origin] += mf * (post ? o.yCOPost : o.yCO) * o.dt;
    co2[origin] += mf * o.yCO2 * o.dt;
    // vent flows: layer spills over a soffit into the next room
    const flows = [];
    for (const v of net.vents) {
      if (!v.open || v.b < 0) continue;
      for (const [from, to] of [[v.a, v.b], [v.b, v.a]]) {
        const A = layer(from), B = layer(to);
        if (A.zi >= v.soffit || m[from] <= 0) continue;
        const rhoTo = B.zi < v.soffit ? B.rho : rhoA;
        const drho = rhoTo - A.rho;
        if (drho <= 0) continue;
        const h = v.soffit - Math.max(A.zi, B.zi < v.soffit ? B.zi : A.zi);
        if (h <= 0) continue;
        const flow = (2 / 3) * 0.7 * v.width * Math.sqrt(2 * G * A.rho * drho) * h ** 1.5;
        flows.push([from, to, Math.min(0.5, (flow * o.dt) / m[from])]);
      }
    }
    for (const [from, to, f] of flows) {
      const dm = m[from] * f, dh = hs[from] * f, ds = soot[from] * f, dc = co[from] * f, dc2 = co2[from] * f;
      m[from] -= dm; hs[from] -= dh; soot[from] -= ds; co[from] -= dc; co2[from] -= dc2;
      m[to] += dm; hs[to] += dh; soot[to] += ds; co[to] += dc; co2[to] += dc2;
    }
    // a room full of smoke pushes the excess out through leaks
    for (let k = 0; k < n; k++) {
      const L = layer(k), cap = net.rooms[k].area * net.rooms[k].height * L.rho;
      if (m[k] > cap) { const f = cap / m[k]; m[k] *= f; hs[k] *= f; soot[k] *= f; co[k] *= f; co2[k] *= f; }
    }
    const L1 = layer(origin);
    if (flashoverAt == null && sprinklerAt == null && L1.T >= 773.15) flashoverAt = t;
    // detectors and sprinklers in the ceiling jet (the jet rides on the hot layer)
    const gasBase = L1.zi < net.rooms[origin].height ? L1.T - 273.15 : Ta - 273.15;
    const link = (dev, temp) => {
      const { dT, u } = ceilingJet(Q, net.rooms[origin].height, dev.r);
      const Tg = gasBase + dT, su = Math.sqrt(Math.max(u, 1e-6));
      return temp + (o.dt * su / dev.rti) * (Tg - temp - (dev.c / su) * (temp - (Ta - 273.15)));
    };
    if (det && alarm == null) { tDet = link(det, tDet); if (tDet >= det.tact) alarm = t; }
    if (spr && sprinklerAt == null) {
      tSpr = link(spr, tSpr);
      if (tSpr >= spr.tact) { sprinklerAt = t; qHeld = Q; if (alarm == null) alarm = t; } // the flow switch raises the alarm
    }
    if (o.detection === 'smoke' && alarm == null && Q > 0) {
      // smoke at a detector 7 m from the fire, carried by the ceiling jet (C/VM2 asks for a
      // ceiling jet correlation): soot and heat travel together, so the jet's soot density is
      // Ysoot rho cp dT / (dHc (1 - chiRad)) for its temperature rise dT (Alpert)
      const { dT } = ceilingJet(Q, net.rooms[origin].height, Math.min(7, Math.sqrt(net.rooms[origin].area) / 2));
      const jet = (o.ySoot * (353 / Ta) * CP * dT) / (o.heatOfCombustion * (1 - o.chiRad));
      if ((KM * jet) / 2.303 >= 0.097) alarm = t;
    }
    while (nextRec <= steps && t >= nextRec - 1e-9) record(nextRec++, Q);
  }
  return { ...out, origin, alarm, warned: alarm == null ? null : alarm + o.notification, sprinklerAt, flashoverAt, opts: o };
}

// Conditions at 2.0 m in room k at time t (s): smoke layer, visibility, gases, heat.
export function conditions(z, k, t) {
  const s = Math.max(0, Math.min(z.t - 1, Math.floor(t)));
  const zi = z.zi[k][s], T = z.T[k][s];
  const inLayer = zi < TENABILITY.height;
  const ext = inLayer ? KM * z.soot[k][s] : 0;
  const Ta = z.opts.ambient;
  return {
    zi, T, inLayer,
    extinction: ext,
    visibility: ext > 0 ? 3 / ext : Infinity,
    co: inLayer ? z.co[k][s] : 0,
    co2: inLayer ? z.co2[k][s] : 0,
    tempC: inLayer ? T - 273.15 : Ta - 273.15,
    radiant: SIGMA * (T ** 4 - Ta ** 4), // from the layer overhead
    flashover: z.flashoverAt != null && k === z.origin && t >= z.flashoverAt,
  };
}

// Doses taken in one step of dt seconds at these conditions (ISO 13571).
export function fedStep(c, dt) {
  const min = dt / 60;
  const hyper = c.co2 > 0 ? Math.exp(0.1903 * c.co2 + 2.0004) / 7.1 : 1;
  const co = (c.co / 35000) * Math.max(1, hyper) * min;
  const heat = c.tempC > 25 ? min / (5e7 * c.tempC ** -3.4) : 0;
  return { co, heat };
}

// When each room stops being tenable at 2.0 m, and which limit goes first.
export function roomASET(z, net) {
  return net.rooms.map((r, k) => {
    let fedCO = 0, fedHeat = 0;
    const vis = r.area < TENABILITY.smallRoom ? TENABILITY.visibilitySmall : TENABILITY.visibility;
    for (let t = 0; t < z.t; t++) {
      const c = conditions(z, k, t);
      const d = fedStep(c, 1);
      fedCO += d.co; fedHeat += d.heat;
      const why = c.flashover ? 'flashover' : c.radiant > TENABILITY.radiant ? 'radiant heat' : c.visibility < vis ? 'visibility' : fedCO > TENABILITY.fed ? 'toxic gases' : fedHeat > TENABILITY.fed ? 'heat' : null;
      if (why) return { id: r.id, aset: t, cause: why, layerBelow2m: firstBelow(z, k) };
    }
    return { id: r.id, aset: null, cause: null, layerBelow2m: firstBelow(z, k) };
  });
}
function firstBelow(z, k) {
  for (let t = 0; t < z.t; t++) if (z.zi[k][t] < TENABILITY.height) return t;
  return null;
}
