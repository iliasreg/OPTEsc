const $ = (s) => document.querySelector(s);
const body=document.body,legacy=$('aside');
const toolbar=document.createElement('header');toolbar.id='workspace-toolbar';
toolbar.innerHTML='<div class="workspace-brand">OPTEsc</div><span class="workspace-notice">Software drill · not emergency guidance</span><nav aria-label="Workspace panels"><button data-panel="setup">Setup</button><button data-panel="details">Results</button><button data-panel="view">View</button></nav>';
body.prepend(toolbar);
const panel=document.createElement('aside');panel.id='workspace-panel';
panel.innerHTML='<div class="workspace-panel-head"><h1 id="workspace-panel-title">Setup</h1><button id="workspace-close" aria-label="Close panel">Close</button></div>';
const sections={};
for(const id of ['setup','details','view']){const e=document.createElement('div');e.id='workspace-'+id;e.className='workspace-section';sections[id]=e;panel.append(e);}
body.append(panel);
function group(title,nodes){const section=document.createElement('section');section.className='workspace-group';const heading=document.createElement('h2');heading.textContent=title;section.append(heading,...nodes);return section;}
toolbar.append($('#sim-run'),$('#status'));
const setup=document.createElement('section');setup.id='simple-sim';
setup.append($('.pick-scenario'),$('#sim-fire').closest('label'));
sections.setup.append(setup,$('#file').closest('label'));
// A plan with no scale of its own (an image, a PDF without "1:100"): its width can be typed.
const scaleRow=document.createElement('div');scaleRow.id='scale-row';
scaleRow.append($('#p-width').closest('label'),$('#scale-note'));
sections.setup.append(scaleRow);
sections.details.append(group('Drill results',[$('#sim-out')]));
const views=document.createElement('div');views.className='workspace-views';
views.append(...document.querySelectorAll('[data-tabbtn]'));
sections.view.append(views,$('#main > .bar .edit-only'));
// The projector and camera plan: a one-page PDF to read, a DXF for CAD.
const exportButton=(id,text,title)=>{const b=document.createElement('button');b.id=id;b.textContent=text;b.title=title;return b;};
const exportNote=document.createElement('p');exportNote.className='workspace-source-note';exportNote.textContent='Where to put the projectors and cameras, and why.';
sections.view.append(group('Export',[exportNote,exportButton('export-pdf','Export PDF','One page: the plan, every projector and camera, and why each is there'),exportButton('export-dxf','Export DXF','Projectors, cameras and signs on their own layers, in the same coordinates as the drawing')]));
// Retain internal defaults and DOM hooks while removing advanced controls from the interface.
legacy.id='workspace-internal';legacy.hidden=true;legacy.setAttribute('aria-hidden','true');
legacy.append($('#main > .bar'));
$('#orbit-hint').hidden=true;$('#walk-hint').hidden=true;
let currentPanel=null;
function showPanel(name){currentPanel=name;body.dataset.panel=name||'';panel.hidden=!name;for(const [id,e]of Object.entries(sections))e.hidden=id!==name;$('#workspace-panel-title').textContent=({setup:'Setup',details:'Results',view:'View'})[name]||'Workspace';toolbar.querySelectorAll('[data-panel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.panel===name)));window.dispatchEvent(new Event('resize'));window.optesc?.viewer?._resize();}
toolbar.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>showPanel(currentPanel===b.dataset.panel?null:b.dataset.panel)));
$('#workspace-close').addEventListener('click',()=>showPanel(null));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&currentPanel)showPanel(null);});
showPanel('setup');
