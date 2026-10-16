import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../frontend/vendor/three.module.js';

// Resolve the browser import map without installing a second copy of Three.js.
const source = fs.readFileSync(new URL('../frontend/src/simview.js', import.meta.url),'utf8')
  .replace("'three'", JSON.stringify(new URL('../frontend/vendor/three.module.js',import.meta.url).href))
  .replace("'./sim.js'", JSON.stringify(new URL('../frontend/src/sim.js',import.meta.url).href))
  .replace("'./drillevents.js'", JSON.stringify(new URL('../frontend/src/drillevents.js',import.meta.url).href));
const { SimLayer } = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('highlight overlay targets room floor or door and clears without changing the site', () => {
  const layer = new SimLayer({scene:new THREE.Scene()});
  assert.equal(typeof layer.highlight,'function');
  const site={grid:{w:3,h:2,cell_m:1,cells:['..D','...'],zone_ids:[[1,1,0],[1,2,2]]},doors:[{id:'D1',cells:[[2,0]]}]};
  const before=JSON.stringify(site);
  layer.highlight({id:'smoke:Z1',scenario:'smoke',zoneIds:['Z1'],doorIds:[]},site);
  assert.equal(layer.cue.count,3);
  assert.deepEqual(layer.cue.userData.zoneIds,['Z1']);
  layer.highlight({id:'door:D1',scenario:'blocked_route',zoneIds:[],doorIds:['D1']},site);
  assert.equal(layer.cue.count,1);
  assert.deepEqual(layer.cue.userData.doorIds,['D1']);
  layer.highlight(null,site);
  assert.equal(layer.cue,null);
  assert.equal(JSON.stringify(site),before);
});

test('projector concepts are surface meshes, toggleable, and disposed on reset', () => {
  const layer = new SimLayer({scene:new THREE.Scene(),wallHeight:2.6});
  assert.equal(typeof layer.updateProjections,'function');
  const ctx=new Proxy({}, {get:(o,k)=>o[k] || (()=>{}),set:(o,k,v)=>(o[k]=v,true)});
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({width:512,height:512,getContext:()=>ctx})};
  try {
    layer.site={grid:{w:5,h:3,cell_m:1,cells:['#####','#...E','#####'],zone_ids:[[0,0,0,0,0],[0,1,1,1,0],[0,0,0,0,0]]},zones:[{id:'Z1',centroid:[2.5,1.5]}],doors:[{id:'D9',x:4.5,y:1.5,along:'y',width_m:1,is_exit:true,connects:['Z1','outside'],cells:[[4,1]]}]};
    layer.result={metrics:{exits:[{id:'D9'}]},hazard:{fireT:new Float32Array(15).fill(Infinity),smokeT:new Float32Array(15).fill(Infinity),tau:new Float32Array(15).fill(20)}};
    layer.updateProjections(0);
    assert.ok(layer.projections.children.some(m=>m.userData.surface==='floor'));
    assert.ok(layer.projections.children.some(m=>m.userData.surface==='wall'));
    assert.ok(layer.projections.children.every(m=>m.isMesh && m.material.depthTest));
    assert.ok(layer.projections.children.filter(m=>m.visible&&m.userData.surface==='floor').every(m=>m.userData.fitsFloor===true));
    layer.setProjections(false);assert.equal(layer.projections.visible,false);
    layer.setProjections(true);assert.equal(layer.projections.visible,true);
    layer.clear();assert.equal(layer.projections.children.length,0);
  } finally {globalThis.document=previous;}
});

test('quake renderer replans on an event inside one time bucket, then restores on rewind',()=>{
 const layer=new SimLayer({scene:new THREE.Scene(),wallHeight:2.6});
 const previous=globalThis.document,ctx=new Proxy({}, {get:(o,k)=>o[k]||(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
 globalThis.document={createElement:()=>({width:512,height:512,getContext:()=>ctx})};
 try{
 layer.site={grid:{w:9,h:5,cell_m:1,cells:['#########','#.......E','#.......#','#.......E','#########'],zone_ids:Array.from({length:5},()=>Array(9).fill(1))},zones:[{id:'Z1',centroid:[3.5,2.5]}],doors:[{id:'D9',x:8.5,y:1.5,along:'y',is_exit:true,width_m:1,connects:['Z1','outside'],cells:[[8,1]]},{id:'D1',x:8.5,y:3.5,along:'y',is_exit:true,width_m:1,connects:['Z1','outside'],cells:[[8,3]]}]};
 const never=()=>new Float32Array(45).fill(Infinity);
 layer.result={quake:{duration:0,events:[{t:4.5}]},metrics:{exits:[{id:'D9'},{id:'D1'}]},hazard:{fireT:never(),smokeT:never(),tau:never(),rubbleT:never(),blockT:never()}};
 layer.result.hazard.blockT[17]=4.5;
 layer.updateProjections(4.4);const first=layer.projections.children[0];
 assert.ok(layer.projections.children.some(m=>m.userData.path?.at(-1)===17));
 layer.updateProjections(4.5);assert.notEqual(layer.projections.children[0],first);
 assert.ok(!layer.projections.children.some(m=>m.visible&&m.userData.path?.at(-1)===17));
 assert.ok(layer.projections.children.some(m=>m.userData.doorId==='D9'&&m.userData.kind==='blocked'));
 const unchanged=layer.projections.children[0];layer.updateProjections(7);assert.equal(layer.projections.children[0],unchanged,'no grid replan without changed damage');
 layer.updateProjections(4.4);assert.ok(layer.projections.children.some(m=>m.userData.path?.at(-1)===17));layer.clear();
 }finally{globalThis.document=previous;}
});
