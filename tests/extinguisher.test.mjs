import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../frontend/vendor/three.module.js';

const source=fs.readFileSync(new URL('../frontend/src/extinguishertraining.js',import.meta.url),'utf8')
  .replace("'three'",JSON.stringify(new URL('../frontend/vendor/three.module.js',import.meta.url).href))
  .replace("'./drillguidance.js'",JSON.stringify(new URL('../frontend/src/drillguidance.js',import.meta.url).href));
const equipment=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const binding=JSON.parse(fs.readFileSync(new URL('../data/rag/site_binding.json',import.meta.url)));

test('extinguisher training remains bound to labelled fictional equipment',()=>{
  assert.equal(equipment.trainingStation('changed'),null);
  const station=equipment.trainingStation(binding.fingerprint);
  assert.equal(station.fictional,true);
  assert.match(station.label,/demo/i);
  assert.ok(station.wallX<41.5,'projection must sit in front of the sample wall inner face at x=41.5');
});

test('usage graphics are a transparent wall projection, not an opaque poster or billboard',()=>{
  assert.equal(typeof equipment.createExtinguisherProjection,'function');
  const station=equipment.trainingStation(binding.fingerprint);
  const mesh=equipment.createExtinguisherProjection(station,new THREE.Texture());
  assert.equal(mesh.userData.surface,'wall');
  assert.equal(mesh.material.transparent,true);
  assert.equal(mesh.material.blending,THREE.NormalBlending);
  assert.equal(mesh.material.depthTest,true);
  assert.equal(mesh.rotation.y,-Math.PI/2);
  assert.equal(mesh.position.x+station.x,station.wallX);
  assert.ok(mesh.geometry.parameters.width>=5);
});

test('equipment UI focuses the wall, with no floating card or modal',()=>{
  const html=fs.readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/Show extinguisher projection/);
  assert.doesNotMatch(source,/evacuationMap|fillText\('EVACUATE/);
  assert.doesNotMatch(html,/id="ext-callout|id="ext-training-dialog/);
  assert.match(html,/hands-on training/i);
  assert.match(html,/usfa\.fema\.gov/);
  assert.match(html,/inrs\.fr/);
});
