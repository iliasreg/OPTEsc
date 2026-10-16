import * as THREE from 'three';
import { siteFingerprint, drillExitIds } from './drillguidance.js';

export function trainingStation(fingerprint) {
  try { drillExitIds(fingerprint); } catch { return null; }
  return {label:'Demo extinguisher — fictional training station',fictional:true,x:41.35,y:18.65,wallX:41.485};
}

export function createExtinguisherProjection(station,map) {
  const material=new THREE.MeshBasicMaterial({map,transparent:true,blending:THREE.NormalBlending,depthTest:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
  const projection=new THREE.Mesh(new THREE.PlaneGeometry(5.2,1.4),material);
  projection.name='extinguisher-wall-projection';
  projection.position.set(station.wallX-station.x,1.85,1.65);
  projection.rotation.y=-Math.PI/2;
  projection.userData={surface:'wall',projected:true,fictional:true};
  return projection;
}

export function initExtinguisherTraining({viewer,getSite}) {
  const status=document.getElementById('ext-training-status');
  const group=new THREE.Group();group.name='fictional-extinguisher-training';viewer.scene.add(group);
  let station=null,board=null,active=false,generation=0,projectionOn=true;
  const trainingMap=new THREE.TextureLoader().load('./assets/extinguisher-projection.svg');
  trainingMap.colorSpace=THREE.SRGBColorSpace;
  function refresh() {
    status.textContent=!station?'Projection unavailable for this plan.':'Four training pictograms projected beside the fictional extinguisher. Generic reminder—not an instruction to stop evacuating.';
    if(board) {
      board.material.map=trainingMap;
      board.visible=projectionOn&&viewer.wallHeight>=2.4;
      board.userData.mode='training';
    }
  }
  function clear() {group.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});group.clear();board=null;station=null;}
  function mesh(geometry,color,x,y,z) {
    const m=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color,roughness:0.6}));
    m.position.set(x,y,z);group.add(m);return m;
  }
  function build(s) {
    group.position.set(s.x,0,s.y);
    mesh(new THREE.CylinderGeometry(.14,.14,.62,24),'#ce3038',0,.86,0);
    mesh(new THREE.SphereGeometry(.14,20,12),'#ce3038',0,1.14,0);
    mesh(new THREE.BoxGeometry(.15,.035,.24),'#27343e',0,1.3,0);
    mesh(new THREE.BoxGeometry(.05,.1,.05),'#27343e',0,1.23,0);
    mesh(new THREE.BoxGeometry(.012,.22,.18),'#f6f4ed',-.145,.88,0);
    const curve=new THREE.CatmullRomCurve3([new THREE.Vector3(0,1.25,.1),new THREE.Vector3(-.12,1.14,.25),new THREE.Vector3(-.12,.83,.24)]);
    mesh(new THREE.TubeGeometry(curve,16,.018,8,false),'#27343e',0,0,0);
    board=createExtinguisherProjection(s,trainingMap);group.add(board);
    group.userData={fictional:true,label:s.label};
  }
  function open() {
    if(!station)return;
    document.querySelector('[data-tabbtn="3d"]').click();
    viewer.setMode('orbit');document.body.dataset.mode='orbit';
    document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode==='orbit')));
    viewer.orbit.target.set(station.wallX,1.7,station.y+1.65);
    viewer.camera.position.set(station.x-4.4,2.2,station.y+1.65);viewer.orbit.update();
    const toggle=document.getElementById('t-projections');toggle.checked=true;toggle.dispatchEvent(new Event('change'));
  }
  viewer.renderer.domElement.addEventListener('click',event=>{
    if(!station||document.body.dataset.tab!=='3d')return;
    const box=viewer.renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1),viewer.camera);
    if(ray.intersectObjects(group.children,true).length) {event.stopImmediatePropagation();open();}
  },true);
  refresh();
  return {
    async siteChanged() {
      const token=++generation,s=getSite();active=false;clear();refresh();if(!s)return;
      try {
        const location=trainingStation(await siteFingerprint(s));
        if(token!==generation||s!==getSite())return;
        if(location&&s.grid.cells[Math.floor(location.y/s.grid.cell_m)]?.[Math.floor(location.x/s.grid.cell_m)]==='.') {station=location;build(station);}
      } catch { /* Unsupported plans have no fictional equipment. */ }
      if(token===generation)refresh();
    },
    setDrillActive(on) {active=on;refresh();},
    setProjectionEnabled(on) {projectionOn=on;refresh();},
    get station(){return station;},get board(){return board;},get active(){return active;},group,open,refresh,
  };
}
