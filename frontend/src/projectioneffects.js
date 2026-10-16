import * as THREE from 'three';
function border(c,w,h,color,look,t){c.strokeStyle=color;c.lineWidth=6;c.shadowColor=color;c.shadowBlur=look==='clear'?8:18;c.globalAlpha=.7;c.strokeRect(18,18,w-36,h-36);c.globalAlpha=1;
 if(look!=='clear'){const perimeter=2*(w+h-72);for(let i=0;i<32;i++){let q=((i/32+t*.07)%1)*perimeter,x,y;const a=w-36,b=h-36;if(q<a){x=18+q;y=18;}else if((q-=a)<b){x=w-18;y=18+q;}else if((q-=b)<a){x=w-18-q;y=h-18;}else{x=18;y=h-18-(q-a);}c.beginPath();c.fillStyle=i%3?'#d6ffe8':'#ffffff';c.arc(x,y,3+i%3,0,Math.PI*2);c.fill();}}
 c.shadowBlur=0;}
function drawSign(a,kind,look,t,wall){const {ctx:c,canvas:{width:w,height:h}}=a;c.clearRect(0,0,w,h);const green=kind==='arrow'||kind==='exit',color=green?'#aaffcf':kind==='smoke'?'#ffe391':'#ff9a8f';border(c,w,h,color,look,t);c.fillStyle=color;c.strokeStyle=color;c.shadowColor=color;c.shadowBlur=9;c.textAlign='center';
 if(wall){c.font='bold 82px Arial';c.fillText(({exit:'DRILL EXIT',excluded:'NOT AN EXIT',blocked:'ROUTE BLOCKED',smoke:'SMOKE'})[kind]||'DRILL',w/2,h*.62,w-70);}
 else {if(kind==='arrow'){c.beginPath();c.moveTo(256,65);c.lineTo(417,228);c.lineTo(317,228);c.lineTo(317,354);c.lineTo(195,354);c.lineTo(195,228);c.lineTo(95,228);c.closePath();c.fill();c.fillStyle='#123b2b';for(let i=0;i<3;i++){const y=160+i*62;c.beginPath();c.moveTo(226,y+20);c.lineTo(256,y-10);c.lineTo(286,y+20);c.lineWidth=9;c.strokeStyle='#123b2b';c.stroke();}}
 else if(green){c.lineWidth=20;c.strokeRect(175,95,170,225);c.beginPath();c.moveTo(110,210);c.lineTo(310,210);c.lineTo(260,165);c.moveTo(310,210);c.lineTo(260,255);c.stroke();}
 else{c.lineWidth=26;c.beginPath();c.moveTo(155,110);c.lineTo(355,310);c.moveTo(355,110);c.lineTo(155,310);c.stroke();}
 c.fillStyle=color;c.font='bold 48px Arial';c.fillText(({arrow:'DRILL',exit:'EXIT',excluded:'NO EXIT',blocked:'BLOCKED',smoke:'SMOKE'})[kind]||'DRILL',256,442,440);
 if(kind==='arrow'&&look!=='clear'){for(let i=0;i<28;i++){const y=350-((i/28+t*.28)%1)*240,x=256+Math.sin(i*7.1)*32;c.fillStyle='#ffffff';c.globalAlpha=.45+(i%4)*.13;c.beginPath();c.arc(x,y,2+i%4,0,Math.PI*2);c.fill();}c.globalAlpha=1;}}
 a.map.needsUpdate=true;}
export function initProjectionEffects(viewer,layer,equipment) {
  const image=new Image();image.src='./assets/extinguisher-crisp.svg';
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const cache=new WeakMap(),trainingFrames=[];
  let last=0;
  function frame(width,height,paint){
    const canvas=document.createElement('canvas');canvas.width=width/2;canvas.height=height/2;
    const ctx=canvas.getContext('2d');ctx.scale(.5,.5);
    const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
    map.generateMipmaps=false;map.minFilter=THREE.LinearFilter;
    paint(ctx,map);return map;
  }
  viewer.projectionEffectsTick=now=>{
    if(document.hidden||now-last<125)return;last=now;
    const motion=!reduced.matches&&(viewer.drillLighting||!layer.result);
    const index=motion?Math.floor(now/125)%4:0;
    if(layer.projectionsEnabled)for(const [key,material] of layer.projectionMaterials){
      let frames=cache.get(material);
      if(!frames){frames=[];cache.set(material,frames);const original=material.map;
        material.addEventListener('dispose',()=>{original.dispose();for(const map of frames)map?.dispose();});}
      const [surface,kind]=key.split(':'),wall=surface==='wall',w=wall?1024:512,h=wall?256:512;
      frames[index] ||= frame(w,h,(ctx,map)=>drawSign({canvas:{width:w,height:h},ctx,map},kind,'focus',index*.125,wall));
      material.map=frames[index];material.color.set('#e3fff0');
    }
    const board=equipment.board;if(!board||!board.visible||!image.complete||!image.naturalWidth)return;
    const step=motion?Math.floor(now/2800)%4:0;
    trainingFrames[step] ||= frame(1600,320,(ctx)=>{
      border(ctx,1600,320,'#b8ffd4','focus',step*.125);ctx.drawImage(image,25,12,1550,290);
      ctx.strokeStyle='#ffffff';ctx.lineWidth=5;ctx.strokeRect(30+step*390,30,370,225);
    });
    board.material.map=trainingFrames[step];
  };
}
