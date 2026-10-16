import test from 'node:test';
import assert from 'node:assert/strict';
import {drillEvents,eventAt} from '../frontend/src/drillevents.js';
const site={zones:[{id:'Z1',name:'Workshop'}],doors:[{id:'D1',is_exit:true}]};
const result={quake:{label:'Strong',duration:10,pga:.3,aftershock:{t:20,duration:4,pga:.1},events:[{t:2,type:'wall',id:'W1',zones:['Z1']},{t:22,type:'door',id:'D1'}]}};
test('earthquake phase guidance overrides subtitle holds and reverses on rewind',()=>{
 const events=drillEvents(result,site);
 assert.equal(eventAt(events,0).scenario,'earthquake');
 assert.equal(eventAt(events,12.99).scenario,'earthquake');
 assert.equal(eventAt(events,13).scenario,'earthquake_after');
 assert.equal(eventAt(events,20).scenario,'earthquake_aftershock');
 assert.equal(eventAt(events,24).scenario,'earthquake_aftershock');
 assert.equal(eventAt(events,25.2).scenario,'earthquake_after');
 assert.equal(eventAt(events,0).scenario,'earthquake');
 assert.deepEqual(events.find(e=>e.id==='alarm').zoneIds,[]);
 assert.equal(events.find(e=>e.id==='alarm').zoneId,'Z1');
});
