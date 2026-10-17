import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function harness() {
  const pdf = deferred(), image = deferred(), ocr = deferred(), fetches = new Map();
  const loaded = [], statuses = [], loops = [], elements = new Map();
  const context = vm.createContext({
    state: {scaleFrom: 'drawing', pxPerM: 30},
    $: id => { if (!elements.has(id)) elements.set(id, {value:'40',addEventListener(){},classList:{add(){},remove(){}}}); return elements.get(id); },
    viewer: {renderer:{setAnimationLoop:fn=>loops.push(fn)},_tick(){}},
    setStatus: (...args)=>statuses.push(args), console:{error(){}},
    Image: class {naturalWidth=100; naturalHeight=100; decode(){return image.promise;}},
    document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}})})},
    renderPdf:()=>pdf.promise,
    renderDxf:()=>({canvas:'dxf',pxPerM:30,texts:[],layers:[]}),
    textHints:()=>[], loadCanvas:(_cv,opts)=>loaded.push(opts),
    readPlanText:(_cv,status)=>{context.ocrStatus=status; return ocr.promise;},
    autoScale:()=>loaded.push('autoscale'), resegment:()=>loaded.push('resegment'),
    process:()=>loaded.push('process'), cellForScale:()=>0.1,
    SAMPLES:{pdf:{url:'pdf'},dxf:{url:'dxf'}},
    fetch:url=>{const d=deferred();fetches.set(url,d);return d.promise;},
    PLAN_FILE:/\.(dxf|pdf|png)$/i,URL:{createObjectURL:()=> 'blob:image'},
  });
  const begin=main.indexOf('let importGeneration');
  if(begin>=0) vm.runInContext(main.slice(begin,main.indexOf('// Render the DXF')),context);
  vm.runInContext(main.slice(main.indexOf('async function loadImage'),main.indexOf('function process()')),context);
  vm.runInContext(main.slice(main.indexOf('function handleFile'),main.indexOf("$('sample').addEventListener")),context);
  return {context,pdf,image,ocr,fetches,loaded,statuses,loops};
}

test('a slow PDF cannot replace a later DXF',async()=>{
  const h=harness();const earlier=h.context.loadPdf(new ArrayBuffer(0),'earlier');
  await h.context.loadDxf('drawing','latest');
  h.pdf.resolve({canvas:'pdf',pxPerM:30,texts:[]});await earlier;
  assert.deepEqual(h.loaded.map(x=>x.kind),['dxf']);
});

test('a stale image decode cannot replace a later DXF',async()=>{
  const h=harness();const earlier=h.context.loadImage('image','earlier',40,[],{ocr:false});
  await h.context.loadDxf('drawing','latest');h.image.resolve();await earlier;
  assert.deepEqual(h.loaded.map(x=>x.kind),['dxf']);
});

test('stale OCR cannot change the new plan, status or renderer loop',async()=>{
  const h=harness();const earlier=h.context.loadImage('image','earlier',40);
  h.image.resolve();await new Promise(r=>setImmediate(r));
  await h.context.loadDxf('drawing','latest');
  const statusCount=h.statuses.length,loopCount=h.loops.length;
  h.context.ocrStatus('old OCR progress');h.ocr.resolve({labels:[{name:'old'}],textBoxes:[]});await earlier;
  assert.equal(h.context.state.hints,undefined);
  assert.equal(h.statuses.length,statusCount);
  assert.equal(h.loops.length,loopCount);
  assert.equal(h.loaded.some(x=>typeof x==='string'),false);
});

test('file selection order wins over asynchronous file reads',async()=>{
  const h=harness(),old=deferred();
  h.context.handleFile({name:'earlier.dxf',text:()=>old.promise});
  h.context.handleFile({name:'latest.dxf',text:async()=> 'new'});
  await new Promise(r=>setImmediate(r));old.resolve('old');await new Promise(r=>setImmediate(r));
  assert.deepEqual(h.loaded.map(x=>x.name),['latest']);
});

test('sample selection order wins over asynchronous fetches',async()=>{
  const h=harness();const earlier=h.context.loadSample('pdf');const latest=h.context.loadSample('dxf');
  h.fetches.get('dxf').resolve({text:async()=> 'new'});await latest;
  h.fetches.get('pdf').resolve({arrayBuffer:async()=>new ArrayBuffer(0)});
  h.pdf.resolve({canvas:'pdf',pxPerM:30,texts:[]});await earlier;
  assert.deepEqual(h.loaded.map(x=>x.kind),['dxf']);
});
