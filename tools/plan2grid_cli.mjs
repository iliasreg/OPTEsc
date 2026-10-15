// Run the browser plan reader from the command line on a raw RGBA image.
//   node plan2grid_cli.mjs in.rgba WIDTH HEIGHT PX_PER_M out.u8 [site.json] [--walls walls.u8]
// out.u8 is one byte per image pixel: 0 outside, 1 room floor, 2 wall, 3 door/window/exit opening.
// --walls: one byte per pixel, 1 = wall, from the AI wall finder instead of the drawing.
import fs from 'node:fs';
import { readPlan, segment, toSite, KIND } from '../frontend/src/plan2grid.js';

const args = process.argv.slice(2);
const wi = args.indexOf('--walls');
const wallFile = wi >= 0 ? args.splice(wi, 2)[1] : null;
const [inFile, W, H, ppm, outFile, siteFile] = args;
const w = Number(W), h = Number(H);
const data = new Uint8ClampedArray(fs.readFileSync(inFile));
const wallMask = wallFile ? new Uint8Array(fs.readFileSync(wallFile)) : null;
const base = readPlan({ width: w, height: h, data }, { pxPerM: Number(ppm), wallMask });
const seg = segment(base);
const { originPx: [ox, oy], cellPx } = base.source;
const code = { [KIND.OUTSIDE]: 0, [KIND.FLOOR]: 1, [KIND.WALL]: 2, [KIND.DOOR]: 3, [KIND.EXIT]: 3, [KIND.WINDOW]: 3 };
const out = new Uint8Array(w * h);
for (let y = 0; y < h; y++) {
  const gy = Math.floor((y + 0.5 - oy) / cellPx);
  for (let x = 0; x < w; x++) {
    const gx = Math.floor((x + 0.5 - ox) / cellPx);
    if (gx < 0 || gy < 0 || gx >= seg.w || gy >= seg.h) continue;
    const i = gy * seg.w + gx;
    out[y * w + x] = seg.kind[i] === KIND.FLOOR && seg.zone[i] <= 0 ? 0 : code[seg.kind[i]];
  }
}
fs.writeFileSync(outFile, out);
if (siteFile) fs.writeFileSync(siteFile, JSON.stringify(toSite(base, seg)));
