// Open any IFC file with web-ifc (an IFC engine independent of the exporter) and show it
// in the three.js view. Used to check that our IFC export reads back correctly.
import * as THREE from 'three';

let apiPromise = null;
async function api() {
  apiPromise ??= (async () => {
    const WebIFC = await import('../vendor/web-ifc-api.js');
    const a = new WebIFC.IfcAPI();
    a.SetWasmPath(new URL('../vendor/', import.meta.url).href, true);
    await a.Init();
    return { a, WebIFC };
  })();
  return apiPromise;
}

// Returns { group, counts } where group holds one mesh per placed geometry (IFC y-up -> three y-up).
export async function loadIfc(bytes) {
  const { a, WebIFC } = await api();
  const id = a.OpenModel(new Uint8Array(bytes));
  const count = (t) => a.GetLineIDsWithType(id, t).size();
  const counts = {
    schema: a.GetModelSchema(id),
    walls: count(WebIFC.IFCWALL) + count(WebIFC.IFCWALLSTANDARDCASE),
    doors: count(WebIFC.IFCDOOR),
    windows: count(WebIFC.IFCWINDOW),
    spaces: count(WebIFC.IFCSPACE),
  };
  const group = new THREE.Group();
  const mats = new Map();
  let meshes = 0;
  a.StreamAllMeshes(id, (mesh) => {
    const geoms = mesh.geometries;
    for (let i = 0; i < geoms.size(); i++) {
      const pg = geoms.get(i);
      const geom = a.GetGeometry(id, pg.geometryExpressID);
      const v = a.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = a.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      // web-ifc packs position + normal per vertex
      const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
      for (let k = 0; k < v.length / 6; k++) {
        pos.set(v.subarray(k * 6, k * 6 + 3), k * 3);
        nor.set(v.subarray(k * 6 + 3, k * 6 + 6), k * 3);
      }
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      bg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      bg.setIndex(new THREE.BufferAttribute(idx, 1));
      const c = pg.color;
      const key = `${c.x},${c.y},${c.z},${c.w}`;
      if (!mats.has(key)) {
        mats.set(key, new THREE.MeshStandardMaterial({
          color: new THREE.Color(c.x, c.y, c.z), transparent: c.w < 1, opacity: c.w, side: THREE.DoubleSide, roughness: 0.8,
        }));
      }
      const m = new THREE.Mesh(bg, mats.get(key));
      m.applyMatrix4(new THREE.Matrix4().fromArray(pg.flatTransformation));
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      meshes++;
      geom.delete?.();
    }
  });
  a.CloseModel(id);
  counts.meshes = meshes;
  return { group, counts };
}
