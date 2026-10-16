import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as policy from '../frontend/src/drillguidance.js';
import { prepare, simulate, worstFire } from '../frontend/src/sim.js';

test('sample exit policy requires the exact bound geometry', async () => {
  assert.equal(typeof policy.drillExitIds, 'function');
  const binding=JSON.parse(fs.readFileSync(new URL('../data/rag/site_binding.json',import.meta.url)));
  assert.deepEqual(policy.drillExitIds(binding.fingerprint),['D9']);
  assert.throws(()=>policy.drillExitIds('changed'),/exit policy/i);
});

const site = () => ({grid:{w:5,h:3,cell_m:1,cells:['#####','E...E','#####'],zone_ids:[[0,0,0,0,0],[0,1,1,1,0],[0,0,0,0,0]]},zones:[{id:'Z1',name:'Room',type:'office',centroid:[2.5,1.5],area_m2:3}],doors:[{id:'D1',is_exit:true,cells:[[0,1]],width_m:1},{id:'D9',is_exit:true,cells:[[4,1]],width_m:1}],evacuationExitIds:['D9']});

test('exit policy removes disallowed and unbound grid exits without mutating geometry', () => {
  const s=site(), before=JSON.stringify(s), g=prepare(s);
  assert.equal(g.kind[5],3);
  assert.equal(g.kind[9],4);
  assert.equal(g.doors[0].exit,false);
  assert.equal(JSON.stringify(s),before);
  s.evacuationExitIds=[];
  assert.ok(!prepare(s).kind.includes(4));
});

test('normal and worst-fire runs cannot escape through excluded exits', () => {
  const s=site(); s.evacuationExitIds=[];
  const opts={total:1,maxTime:1,preMove:[0,0],fireSpeed:0.001};
  assert.equal(simulate(s,opts).metrics.out,0);
  assert.equal(simulate(s,opts).metrics.exits.length,0);
  assert.ok(worstFire(s,opts).runs.every(r=>r.harmed===1));
});
