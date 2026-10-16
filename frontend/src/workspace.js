const $ = (s) => document.querySelector(s);
const body = document.body, oldAside = $('aside');
const toolbar = document.createElement('header');
toolbar.id = 'workspace-toolbar';
toolbar.innerHTML = '<div class="workspace-brand">OPTEsc <span>Drill workspace</span></div><span class="workspace-notice">Software drill · not emergency guidance</span><nav aria-label="Workspace panels"><button data-panel="setup">Setup</button><button data-panel="details">Details</button><button data-panel="view">View</button></nav>';
body.prepend(toolbar);
const panel = document.createElement('aside'); panel.id='workspace-panel';
panel.innerHTML='<div class="workspace-panel-head"><h1 id="workspace-panel-title">Setup</h1><button id="workspace-close" aria-label="Close panel">×</button></div>';
const sections={};
for(const id of ['setup','details','view']){const e=document.createElement('div');e.id='workspace-'+id;e.className='workspace-section';sections[id]=e;panel.append(e)}
body.append(panel);
function group(title,nodes,open=false){const d=document.createElement('details');d.className='workspace-group';d.open=open;const s=document.createElement('summary');s.textContent=title;d.append(s);for(const n of nodes)if(n)d.append(n);return d}
const upload=$('#file').closest('.row'), exports=$('#export').closest('.row'), scale=$('#p-width').closest('section');
const guidance=$('#drill-guidance'), results=$('#sim-out'), simulation=$('#sim');
const stats=$('#stats').closest('section'), issues=$('#issues').closest('section'), zones=$('#zones').closest('section');
const originalBar=$('#main > .bar');
toolbar.append($('#sim-run'));
sections.setup.append(simulation);
sections.setup.append(group('Building & import',[upload,scale],false));
sections.setup.append(group('Guidance & audio',[guidance],false));
sections.details.append(group('Building checks',[stats,issues],true));
sections.details.append(group('Drill results',[results],false));
sections.details.append(group('Rooms & measurements',[zones],false));
sections.details.append(group('Export',[exports],false));
const sources=document.createElement('p');sources.className='workspace-source-note';sources.textContent='Source references remain beneath the scene subtitles. Open Setup → Guidance & audio for full citations and optional speech.';sections.details.append(sources);
sections.view.append(originalBar);
const legend=$('.legend');if(legend)sections.view.append(legend);
const status=$('#status');status.id='status';toolbar.append(status);
oldAside.remove();
let currentPanel=null;
function showPanel(name){currentPanel=name;body.dataset.panel=name||'';panel.hidden=!name;for(const [id,e] of Object.entries(sections))e.hidden=id!==name;$('#workspace-panel-title').textContent=({setup:'Drill setup',details:'Details & results',view:'View & edit'})[name]||'Workspace';toolbar.querySelectorAll('[data-panel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.panel===name)));window.dispatchEvent(new Event('resize'));window.optesc?.viewer?._resize()}
toolbar.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>showPanel(currentPanel===b.dataset.panel?null:b.dataset.panel)));
$('#workspace-close').addEventListener('click',()=>showPanel(null));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&currentPanel)showPanel(null)});
// Keep mandatory warnings available; only their location changes.
$('#sim-worst').closest('.row').classList.add('workspace-extra-run');
const advanced=group('Advanced drill controls',[$('#sim-pick'),$('#sim-worst')],false);simulation.insertBefore(advanced,simulation.firstElementChild.nextSibling);
showPanel('setup');
