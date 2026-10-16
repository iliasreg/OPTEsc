import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../frontend/vendor/three.module.js';

// Resolve the browser import map without installing a second copy of Three.js.
const source = fs.readFileSync(new URL('../frontend/src/simview.js', import.meta.url),'utf8')
  .replace("'three'", JSON.stringify(new URL('../frontend/vendor/three.module.js',import.meta.url).href))
  .replace("'./sim.js'", JSON.stringify(new URL('../frontend/src/sim.js',import.meta.url).href));
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
