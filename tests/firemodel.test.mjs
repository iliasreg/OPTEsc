// The two-zone fire model against hand calculations and published correlations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneFire, plumeMass, ceilingJet, fedStep, roomASET, conditions, roomNetwork, FIRE_GROWTH } from '../frontend/src/firemodel.js';

const one = (area, height) => ({ rooms: [{ id: 'Z1', area, height }], vents: [] });
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);

test('design fire: fast t-squared growth (0.0469 t^2 kW), capped at 20 MW', () => {
  const z = zoneFire(one(5000, 10), 0, { ceiling: 10, maxTime: 900, detection: 'none' });
  assert.ok(near(z.Q[100], 469, 0.01), `${z.Q[100]}`);
  assert.ok(near(z.Q[300], 4221, 0.01));
  assert.equal(Math.round(z.Q[800]), 20000);
  assert.equal(FIRE_GROWTH.ultrafast, 0.1876);
});

test('Heskestad plume and Alpert ceiling jet match hand calculations', () => {
  // 1 MW, 3 m above the fire: 0.071 (650)^(1/3) 3^(5/3) + 0.0018 x 650 = 5.0 kg/s
  assert.ok(near(plumeMass(1000, 3), 5.0, 0.02), `${plumeMass(1000, 3)}`);
  // close to the axis: 16.9 Q^(2/3) / H^(5/3) = 270.8 K; further out: 5.38 (Q/r)^(2/3) / H
  assert.ok(near(ceilingJet(1000, 3, 0.3).dT, 270.8, 0.01));
  assert.ok(near(ceilingJet(1000, 3, 4).dT, (5.38 * (1000 / 4) ** (2 / 3)) / 3, 1e-6));
  assert.ok(near(ceilingJet(1000, 3, 0.3).u, 0.96 * (1000 / 3) ** (1 / 3), 1e-6));
});

test('smoke layer height close to the NFPA 92 correlation (at most 0.2 H lower, 0.05 H higher) while the layer is high', () => {
  // NFPA 92: z/H = 0.91 (t H^-0.8 tg^-0.4 (A/H^2)^-0.6)^-1.45, tg = time to 1055 kW; fitted on
  // large spaces, so compared while the layer is in the upper half (deeper down, in a small
  // closed room, the zone model fills it sooner: on the safe side)
  const tg = Math.sqrt(1055 / 0.0469);
  for (const [A, H] of [[100, 3], [400, 6], [1000, 8], [2000, 12]]) {
    const z = zoneFire(one(A, H), 0, { ceiling: H, maxTime: 600, detection: 'none' });
    for (let t = 30; t <= 600; t += 10) {
      const zh = 0.91 * (t * H ** -0.8 * tg ** -0.4 * (A / H / H) ** -0.6) ** -1.45;
      if (zh > 0.9 || zh < 0.5) continue; // before 0.9 the correlation still lags the first filling
      const model = z.zi[0][t] / H;
      // lower is the safe side: smoke reaches people sooner in the model
      assert.ok(model >= zh - 0.2 && model <= zh + 0.05, `A ${A} H ${H} t ${t}: model ${model.toFixed(2)} NFPA ${zh.toFixed(2)}`);
    }
  }
});

test('detection: smoke detectors before heat detectors; sprinklers hold the fire and prevent flashover', () => {
  const room = one(200, 3);
  const smoke = zoneFire(room, 0, { detection: 'smoke' }), heat = zoneFire(room, 0, { detection: 'heat' });
  assert.ok(smoke.alarm < heat.alarm, `${smoke.alarm} vs ${heat.alarm}`);
  const quick = zoneFire(room, 0, { detection: 'none', sprinklers: 'quick' }), std = zoneFire(room, 0, { detection: 'none', sprinklers: 'standard' });
  assert.ok(quick.sprinklerAt < std.sprinklerAt);
  const after = Math.ceil(quick.sprinklerAt) + 5;
  assert.equal(quick.Q[after], quick.Q[after + 300]);
  assert.equal(quick.flashoverAt, null);
  assert.equal(quick.alarm, quick.sprinklerAt, 'the sprinkler flow switch raises the alarm');
  const free = zoneFire(one(30, 2.6), 0, { detection: 'none', maxTime: 900 });
  assert.ok(free.flashoverAt != null, 'a small room with no sprinklers flashes over');
});

test('smoke spreads through open doors, not closed ones', () => {
  const site = { zones: [{ id: 'Z1', area_m2: 60 }, { id: 'Z2', area_m2: 60 }], doors: [{ id: 'D1', width_m: 0.9, connects: ['Z1', 'Z2'] }] };
  const openNet = roomNetwork(site, { interiorDoors: 'open', ceiling: 3 }), shut = roomNetwork(site, { interiorDoors: 'closed', ceiling: 3 });
  const a = zoneFire(openNet, 0, { maxTime: 600 }), b = zoneFire(shut, 0, { maxTime: 600 });
  assert.ok(a.zi[1][400] < 2, 'next room fills through the open door');
  assert.equal(b.zi[1][600], 3, 'a closed door keeps the next room clear');
  const aset = roomASET(a, openNet);
  assert.ok(aset[0].aset < aset[1].aset, 'the room of origin goes first');
});

test('ISO 13571 doses: 35 000 ppm.min of CO is a full dose; convected heat 5e7 T^-3.4 minutes', () => {
  const co = fedStep({ co: 3500, co2: 0, tempC: 20 }, 600);
  assert.ok(near(co.co, 1, 1e-9));
  // CO2 makes people breathe faster: more CO taken up
  assert.ok(fedStep({ co: 3500, co2: 3, tempC: 20 }, 600).co > 1.5);
  const heat = fedStep({ co: 0, co2: 0, tempC: 100 }, 60);
  assert.ok(near(heat.heat, 1 / (5e7 * 100 ** -3.4), 1e-9));
  assert.ok(heat.heat > 0.12 && heat.heat < 0.13, 'about 8 minutes to a full dose at 100 C');
});

test('tenability is judged at 2 m: no exposure while the layer stays above head height', () => {
  const z = zoneFire(one(500, 8), 0, { maxTime: 120, detection: 'none' });
  const c = conditions(z, 0, 60);
  assert.ok(c.zi > 2 && !c.inLayer && c.visibility === Infinity && c.co === 0);
});
