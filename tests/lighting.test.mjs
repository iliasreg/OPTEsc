import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../frontend/vendor/three.module.js';
const code=fs.readFileSync(new URL('../frontend/src/viewer3d.js',import.meta.url),'utf8')
 .replace("'three'",JSON.stringify(new URL('../frontend/vendor/three.module.js',import.meta.url).href))
 .replace("'./objects.js'",JSON.stringify(new URL('../frontend/src/objects.js',import.meta.url).href))
 .replace(/^import .*Controls.*;$/gm,'');
const {Viewer}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('playback dims exterior and restores exact idle colours and lighting',()=>{
 const v=Object.create(Viewer.prototype);v.scene=new THREE.Scene();v.scene.background=new THREE.Color('#dfe6ee');v.scene.fog=new THREE.Fog('#dfe6ee',80,220);
 v.root=new THREE.Group();const ground=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshStandardMaterial({color:'#c3cbb8'}));ground.name='exterior-ground';v.root.add(ground);
 v.sun=new THREE.DirectionalLight('#ffffff',1.6);const ambient=new THREE.HemisphereLight('#ffffff','#8a9099',1.4);v.scene.add(v.sun,ambient);
 v.setDrillLighting(true);assert.equal(v.scene.background.getHexString(),'0d1513');assert.equal(ground.material.color.getHexString(),'14201b');assert.equal(v.sun.intensity,1.6*0.42);
 v.setDrillLighting(false);assert.equal(v.scene.background.getHexString(),'dfe6ee');assert.equal(v.scene.fog.color.getHexString(),'dfe6ee');assert.equal(ground.material.color.getHexString(),'c3cbb8');assert.equal(v.sun.intensity,1.6);assert.equal(ambient.intensity,1.4);
});
