import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../frontend/vendor/three.module.js';
const source=fs.readFileSync(new URL('../frontend/src/projectioneffects.js',import.meta.url),'utf8').replace("'three'",JSON.stringify(new URL('../frontend/vendor/three.module.js',import.meta.url).href));
const {initProjectionEffects}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('particle frames are bounded, reused, and training stays visible during drills',()=>{
 const saved={document:globalThis.document,Image:globalThis.Image,matchMedia:globalThis.matchMedia};
 let canvases=0,images=0;const text=[];
 const ctx=new Proxy({drawImage:()=>images++,fillText:s=>text.push(s)},{get:(o,k)=>o[k]||(()=>{})});
 globalThis.document={hidden:false,createElement:()=>{canvases++;return {getContext:()=>ctx};}};
 globalThis.Image=class{complete=true;naturalWidth=1600;};globalThis.matchMedia=()=>({matches:false});
 try{
 const material=new THREE.MeshBasicMaterial({map:new THREE.Texture()}),viewer={drillLighting:true};
 const layer={result:{},projectionsEnabled:true,projectionMaterials:new Map([['floor:arrow',material]])};
 const equipment={active:true,board:{visible:true,material:new THREE.MeshBasicMaterial()}};
 initProjectionEffects(viewer,layer,equipment);
 for(let i=1;i<=100;i++)viewer.projectionEffectsTick(i*125);
 const warmed=canvases;assert.equal(warmed,8);assert.equal(images,4);assert.ok(!text.includes('EVACUATE'));
 const versions=new Map();
 for(let i=101;i<=200;i++){viewer.projectionEffectsTick(i*125);versions.set(material.map.uuid,material.map.version);}
 assert.equal(canvases,warmed);assert.equal(versions.size,4);assert.equal(images,4);
 document.hidden=true;viewer.projectionEffectsTick(30000);assert.equal(canvases,warmed);
 }finally{Object.assign(globalThis,saved);}
});
