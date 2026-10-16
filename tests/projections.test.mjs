import test from 'node:test';
import assert from 'node:assert/strict';
import * as projection from '../frontend/src/drillevents.js';

function fixture() {
  const grid={w:9,h:5,cell_m:1,cells:['#########','#.......E','#.......#','#.......E','#########'],zone_ids:Array.from({length:5},()=>Array(9).fill(1))};
  const site={grid,zones:[{id:'Z1',name:'Room',centroid:[3.5,2.5]}],doors:[{id:'D1',x:8.5,y:3.5,is_exit:true,connects:['Z1','outside'],cells:[[8,3]],width_m:1},{id:'D9',x:8.5,y:1.5,is_exit:true,connects:['Z1','outside'],cells:[[8,1]],width_m:1}]};
  const n=45, hazard={fireT:new Float32Array(n).fill(Infinity),smokeT:new Float32Array(n).fill(Infinity),tau:new Float32Array(n).fill(20)};
  return {site,result:{hazard,metrics:{exits:[{id:'D9'}]}},hazard};
}

test('projected arrows end at permitted exits; excluded openings get a cross',()=>{
  assert.equal(typeof projection.projectionPlan,'function');
  const {site,result}=fixture(), plan=projection.projectionPlan(site,result,0);
  assert.ok(plan.arrows.length>0);
  assert.ok(plan.arrows.every(a=>a.path.at(-1)===17));
  for(const a of plan.arrows) for(let k=1;k<a.path.length;k++) {
    const i=a.path[k-1],j=a.path[k],x=i%9,y=Math.floor(i/9),nx=j%9,ny=Math.floor(j/9);
    if(x!==nx&&y!==ny) assert.ok(a.guards?.includes(y*9+nx)&&a.guards?.includes(ny*9+x));
  }
  assert.equal(plan.signs.find(s=>s.id==='D1').kind,'excluded');
  assert.equal(plan.signs.find(s=>s.id==='D9').kind,'exit');
});

test('projections withdraw arrows when no smoke-free route remains and restore on rewind',()=>{
  const {site,result,hazard}=fixture();
  hazard.smokeT[17]=0;
  assert.ok(projection.projectionPlan(site,result,0).arrows.length>0);
  assert.equal(projection.projectionPlan(site,result,10).arrows.length,0);
  assert.equal(projection.projectionPlan(site,result,10).signs.find(s=>s.id==='D9').kind,'smoke');
  assert.ok(projection.projectionPlan(site,result,0).arrows.length>0);
});

test('fire-blocked exit withdraws arrows at navigation threshold without future warnings',()=>{
  const {site,result,hazard}=fixture(); hazard.fireT[17]=10;
  assert.equal(projection.projectionPlan(site,result,7).signs.find(s=>s.id==='D9').kind,'exit');
  const plan=projection.projectionPlan(site,result,8);
  assert.equal(plan.signs.find(s=>s.id==='D9').kind,'blocked');
  assert.equal(plan.arrows.length,0);
});
