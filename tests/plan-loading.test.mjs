import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const main=fs.readFileSync(new URL('../frontend/src/main.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(){
  const events=[],site={zones:[{id:'Z1'}]},ready=deferred();
  const context=vm.createContext({
    state:{site},sceneReady:ready.promise,
    viewer:{site,_resize:()=>events.push('resize'),renderer:{setAnimationLoop(){}},_tick(){}},
    welcome:{showLoading:n=>events.push(['loading',n]),showWorkspace:()=>events.push('workspace'),showError:m=>events.push(['error',m])},
    document:{visibilityState:'visible'},requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),
    setStatus:()=>{},console:{error(){}},
  });
  vm.runInContext(main.slice(main.indexOf('let importGeneration'),main.indexOf('// Render the DXF')),context);
  vm.runInContext(main.slice(main.indexOf('async function openPlan'),main.indexOf('const drop =')),context);
  return {context,events,ready};
}

test('welcome stays loading until decoding and scene equipment are ready',async()=>{
  assert.ok(main.includes('async function openPlan'), 'imports need a shared loading lifecycle');
  const h=harness(),decode=deferred();
  const importing=h.context.openPlan(()=>decode.promise,'factory.dxf');
  assert.deepEqual(h.events,[['loading','factory.dxf']]);
  decode.resolve();await new Promise(r=>setImmediate(r));
  assert.ok(!h.events.includes('workspace'),'equipment is not ready yet');
  h.ready.resolve();await importing;
  assert.deepEqual(h.events,[['loading','factory.dxf'],'workspace','resize']);
});

test('failed model import returns to the welcome screen with the error',async()=>{
  assert.ok(main.includes('async function openPlan'));
  const h=harness();
  await h.context.openPlan(async()=>{throw new Error('Invalid DXF');},'bad.dxf');
  assert.deepEqual(h.events,[['loading','bad.dxf'],['error','Invalid DXF']]);
});

test('a stale import cannot reveal the workspace or hide a newer loading screen',async()=>{
  assert.ok(main.includes('async function openPlan'));
  const h=harness(),old=deferred(),latest=deferred();h.ready.resolve();
  const first=h.context.openPlan(()=>old.promise,'old.pdf');
  await new Promise(r=>setImmediate(r));
  const second=h.context.openPlan(()=>latest.promise,'new.dxf');
  old.resolve();await first;
  assert.deepEqual(h.events,[['loading','old.pdf'],['loading','new.dxf']]);
  latest.resolve();await second;
  assert.equal(h.events.filter(e=>e==='workspace').length,1);
});

test('the app starts at welcome rather than automatically importing the sample',()=>{
  const html=fs.readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
  assert.match(html,/<body[^>]*data-screen="home"/);
  assert.doesNotMatch(main,/^loadSample\('dxf'\);/m);
});
