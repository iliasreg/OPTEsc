// Site JSON -> IFC4 (STEP text) with walls, doors, windows and spaces, so the model opens
// in BIM tools. Site metres have y pointing down the plan; IFC uses y up, so Y = -y.
import { KIND } from './plan2grid.js';

const KIND_OF = { o: KIND.OUTSIDE, '.': KIND.FLOOR, '#': KIND.WALL, D: KIND.DOOR, E: KIND.EXIT, W: KIND.WINDOW };

export function siteToIfc(site, { wallHeight = 3, doorHeight = 2.1, sillHeight = 0.9 } = {}) {
  const g = site.grid, c = g.cell_m;
  const kind = new Uint8Array(g.w * g.h);
  g.cells.forEach((row, y) => { for (let x = 0; x < g.w; x++) kind[y * g.w + x] = KIND_OF[row[x]] ?? 0; });
  const lintel = Math.min(doorHeight, wallHeight - 0.1);
  const sill = Math.min(sillHeight, lintel - 0.2);

  const lines = [];
  let n = 0;
  const add = (s) => { lines.push(`#${++n}=${s};`); return `#${n}`; };
  const str = (s) => (s == null ? '$' : `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, (ch) => encodeX2(ch))}'`);
  const pt = (x, y, z) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)}${z === undefined ? '' : ',' + f(z)}))`);
  const dirZ = add('IFCDIRECTION((0.,0.,1.))');
  const dirX = add('IFCDIRECTION((1.,0.,0.))');
  const origin = pt(0, 0, 0);
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},${dirZ},${dirX})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = add(`IFCUNITASSIGNMENT((${[
    add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'), add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'), add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
  ].join(',')}))`);
  const project = add(`IFCPROJECT(${guid()},$,${str(site.name)},$,$,$,$,(${ctx}),${units})`);
  const place = (rel, x, y, z, xdir = null) => {
    const ax = add(`IFCAXIS2PLACEMENT3D(${pt(x, y, z)},${xdir ? dirZ : '$'},${xdir ? add(`IFCDIRECTION((${f(xdir[0])},${f(xdir[1])},0.))`) : '$'})`);
    return add(`IFCLOCALPLACEMENT(${rel ?? '$'},${ax})`);
  };
  const sitePl = place(null, 0, 0, 0);
  const ifcSite = add(`IFCSITE(${guid()},$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = place(sitePl, 0, 0, 0);
  const building = add(`IFCBUILDING(${guid()},$,${str(site.name)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const stPl = place(bldPl, 0, 0, 0);
  const storey = add(`IFCBUILDINGSTOREY(${guid()},$,'Ground floor',$,$,${stPl},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${project},(${ifcSite}))`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${ifcSite},(${building}))`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${building},(${storey}))`);

  const shape = (solid) => add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`)}))`);
  // box centred on (cx, cy) in local coordinates, from z0 to z1
  const box = (cx, cy, dx, dy, z0, z1) => {
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${add(`IFCAXIS2PLACEMENT2D(${pt(cx, cy)},$)`)},${f(dx)},${f(dy)})`);
    return add(`IFCEXTRUDEDAREASOLID(${prof},${add(`IFCAXIS2PLACEMENT3D(${pt(0, 0, z0)},$,$)`)},${dirZ},${f(z1 - z0)})`);
  };
  const contained = [];
  const rectWorld = ([x, y, w, h]) => ({ cx: (x + w / 2) * c, cy: -(y + h / 2) * c, dx: w * c, dy: h * c });

  // walls (and the wall pieces above doors and around windows)
  const wallRects = mergeRects(kind, g.w, g.h, (k) => k === KIND.WALL);
  wallRects.forEach((r, k) => {
    const { cx, cy, dx, dy } = rectWorld(r);
    contained.push(add(`IFCWALL(${guid()},$,${str(`Wall ${k + 1}`)},$,$,${place(stPl, cx, cy, 0)},${shape(box(0, 0, dx, dy, 0, wallHeight))},$,.STANDARD.)`));
  });
  for (const r of mergeRects(kind, g.w, g.h, (k) => k === KIND.DOOR || k === KIND.EXIT)) {
    const { cx, cy, dx, dy } = rectWorld(r);
    contained.push(add(`IFCWALL(${guid()},$,'Lintel',$,$,${place(stPl, cx, cy, 0)},${shape(box(0, 0, dx, dy, lintel, wallHeight))},$,.STANDARD.)`));
  }
  const winRects = mergeRects(kind, g.w, g.h, (k) => k === KIND.WINDOW);
  winRects.forEach((r, k) => {
    const { cx, cy, dx, dy } = rectWorld(r);
    const pl = place(stPl, cx, cy, 0);
    contained.push(add(`IFCWALL(${guid()},$,'Sill',$,$,${pl},${shape(box(0, 0, dx, dy, 0, sill))},$,.STANDARD.)`));
    contained.push(add(`IFCWALL(${guid()},$,'Lintel',$,$,${place(stPl, cx, cy, 0)},${shape(box(0, 0, dx, dy, lintel, wallHeight))},$,.STANDARD.)`));
    const along = Math.max(dx, dy), thick = Math.min(dx, dy);
    contained.push(add(`IFCWINDOW(${guid()},$,${str(`Window ${k + 1}`)},$,$,${place(stPl, cx, cy, sill)},${shape(box(0, 0, dx, Math.min(dy, Math.max(thick, 0.05)), 0, lintel - sill))},$,${f(lintel - sill)},${f(along)},.WINDOW.,.SINGLE_PANEL.,$)`));
  });

  // doors: local x along the gap, local y towards the side the leaf opens into
  const doorEls = [];
  for (const d of site.doors) {
    const xdir = d.along === 'y' ? [0, -1] : [1, 0];
    let sign = 1;
    if (d.swing) sign = d.swing.toward === '+y' ? -1 : d.swing.toward === '-y' ? 1 : d.swing.toward === '+x' ? 1 : -1;
    // local y = z × x; flip x so that local y points along the swing
    const ly = [-xdir[1], xdir[0]];
    const swingWorld = d.along === 'y' ? [sign, 0] : [0, sign];
    const flip = ly[0] * swingWorld[0] + ly[1] * swingWorld[1] < 0;
    const xd = flip ? [-xdir[0], -xdir[1]] : xdir;
    let op = '.NOTDEFINED.';
    if (d.swing) {
      // hinge left when it sits on the -x side of the door's local axes
      const hx = d.swing.hinge[0] - d.x, hy = -(d.swing.hinge[1] - d.y);
      op = hx * xd[0] + hy * xd[1] < 0 ? '.SINGLE_SWING_LEFT.' : '.SINGLE_SWING_RIGHT.';
    } else if (d.width_m > 2.5) op = '.ROLLINGUP.';
    const pl = place(stPl, d.x, -d.y, 0, xd);
    const el = add(`IFCDOOR(${guid()},$,${str(d.id)},${str(d.is_exit ? 'Exit door' : null)},$,${pl},${shape(box(0, 0, d.width_m, 0.05, 0, lintel))},$,${f(lintel)},${f(d.width_m)},.DOOR.,${op},$)`);
    contained.push(el);
    doorEls.push([d, el]);
  }

  // spaces with their measured area and travel distance
  const spaceEls = [];
  for (const z of site.zones) {
    if (z.polygon.length < 3) continue;
    const ring = z.polygon.map(([x, y]) => pt(x, -y));
    const poly = add(`IFCPOLYLINE((${[...ring, ring[0]].join(',')}))`);
    const prof = add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,${str(z.name)},${poly})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${prof},${add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)},${dirZ},${f(wallHeight)})`);
    const sp = add(`IFCSPACE(${guid()},$,${str(z.id)},$,$,${place(stPl, 0, 0, 0)},${shape(solid)},${str(z.name)},.ELEMENT.,.INTERNAL.,$)`);
    spaceEls.push(sp);
    const q = add(`IFCELEMENTQUANTITY(${guid()},$,'Qto_SpaceBaseQuantities',$,$,(${add(`IFCQUANTITYAREA('NetFloorArea',$,$,${f(z.area_m2)},$)`)}))`);
    add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${sp}),${q})`);
    const props = [add(`IFCPROPERTYSINGLEVALUE('ZoneType',$,IFCLABEL(${str(z.type)}),$)`)];
    const e = site.egress?.zones?.[z.id];
    if (e && Number.isFinite(e.max_m)) props.push(add(`IFCPROPERTYSINGLEVALUE('MaxTravelToExit',$,IFCLENGTHMEASURE(${f(e.max_m)}),$)`));
    if (z.printed_area_m2) props.push(add(`IFCPROPERTYSINGLEVALUE('PrintedArea',$,IFCAREAMEASURE(${f(z.printed_area_m2)}),$)`));
    add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${sp}),${add(`IFCPROPERTYSET(${guid()},$,'OPTEsc_Zone',$,(${props.join(',')}))`)})`);
  }
  if (spaceEls.length) add(`IFCRELAGGREGATES(${guid()},$,$,$,${storey},(${spaceEls.join(',')}))`);
  for (const [d, el] of doorEls) {
    const props = [add(`IFCPROPERTYSINGLEVALUE('FireExit',$,IFCBOOLEAN(${d.is_exit ? '.T.' : '.F.'}),$)`)];
    add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${el}),${add(`IFCPROPERTYSET(${guid()},$,'Pset_DoorCommon',$,(${props.join(',')}))`)})`);
    const own = [add(`IFCPROPERTYSINGLEVALUE('Connects',$,IFCLABEL(${str(d.connects.join(' / '))}),$)`)];
    if (d.swing) {
      own.push(add(`IFCPROPERTYSINGLEVALUE('OpensInto',$,IFCLABEL(${str(d.swing.into ?? 'unknown')}),$)`));
      own.push(add(`IFCPROPERTYSINGLEVALUE('SwingConfidence',$,IFCREAL(${f(d.swing.confidence)}),$)`));
    }
    add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${el}),${add(`IFCPROPERTYSET(${guid()},$,'OPTEsc_Door',$,(${own.join(',')}))`)})`);
  }
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,(${contained.join(',')}),${storey})`);

  const now = new Date().toISOString().slice(0, 19);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${str((site.name || 'site') + '.ifc')},'${now}',(''),(''),'OPTEsc plan to 3D','OPTEsc','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

function f(v) {
  const s = (Math.round(v * 10000) / 10000).toString();
  return s.includes('.') || s.includes('e') ? s : s + '.';
}

// IFC GlobalId: 22 characters of the IFC base64 alphabet
const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function guid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = ALPHA[b[0] & 3];
  let acc = 0, bits = 0;
  for (let i = 1; i < 16; i++) {
    acc = (acc << 8) | b[i]; bits += 8;
    while (bits >= 6 && s.length < 22) { bits -= 6; s += ALPHA[(acc >> bits) & 63]; }
  }
  while (s.length < 22) s += ALPHA[acc & 63];
  return `'${s}'`;
}

function encodeX2(ch) {
  return `\\X2\\${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
}

function mergeRects(kind, w, h, pred) {
  const used = new Uint8Array(w * h);
  const rects = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (used[i] || !pred(kind[i])) continue;
    let rw = 1;
    while (x + rw < w && !used[i + rw] && pred(kind[i + rw])) rw++;
    let rh = 1;
    grow: while (y + rh < h) {
      for (let k = 0; k < rw; k++) {
        const j = (y + rh) * w + x + k;
        if (used[j] || !pred(kind[j])) break grow;
      }
      rh++;
    }
    for (let yy = 0; yy < rh; yy++) for (let k = 0; k < rw; k++) used[(y + yy) * w + x + k] = 1;
    rects.push([x, y, rw, rh]);
  }
  return rects;
}
