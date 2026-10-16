import test from 'node:test';
import assert from 'node:assert/strict';
import {readTheme,applyTheme} from '../frontend/src/theme.js';

test('theme selection persists and switches the transparent logo colour',()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
 const root={dataset:{}},logo={},button={setAttribute(k,v){this[k]=v;}};
 assert.equal(readTheme(storage),'dark');
 applyTheme(root,logo,button,'light',storage);
 assert.equal(root.dataset.theme,'light');assert.match(logo.src,/black\.png$/);
 assert.equal(button['aria-label'],'Switch to dark mode');assert.equal(readTheme(storage),'light');
 applyTheme(root,logo,button,'dark',storage);
 assert.match(logo.src,/white\.png$/);assert.equal(readTheme(storage),'dark');
});
test('blocked storage and invalid preferences keep the theme control usable',()=>{
 const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 const root={dataset:{}},logo={},button={setAttribute(){}};
 assert.equal(readTheme(storage),'dark');
 assert.doesNotThrow(()=>applyTheme(root,logo,button,'light',storage));
 assert.equal(root.dataset.theme,'light');
 applyTheme(root,logo,button,'invalid',null);assert.equal(root.dataset.theme,'dark');
});
