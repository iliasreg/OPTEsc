// Optional AI wall finder running on this computer (tools/wall_server.py), on its GPU when it has one.
// The page asks it for a wall mask of an image plan; without it, walls come from the drawing.
//
//   aiWallFinder()      -> { device } when the service answers, else null
//   findWalls(canvas)   -> { mask: Uint8Array (1 = wall, per canvas pixel), device, scale }
//
// The address can be changed with ?walls=http://host:port in the page URL.

const BASE = (new URLSearchParams(location.search).get('walls') || 'http://localhost:8766').replace(/\/$/, '');
let probe = null;

export function aiWallFinder() {
  probe ??= (async () => {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  })();
  return probe;
}

export async function findWalls(canvas) {
  const png = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
  const r = await fetch(`${BASE}/walls`, { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
  if (!r.ok) throw new Error(`wall finder answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const bmp = await createImageBitmap(await r.blob());
  const cv = document.createElement('canvas');
  cv.width = canvas.width; cv.height = canvas.height;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  // the service draws walls (and windows, which close the outline like walls) in white
  const mask = new Uint8Array(cv.width * cv.height);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4] > 127 ? 1 : 0;
  return { mask, device: r.headers.get('X-Device') || 'unknown', scale: Number(r.headers.get('X-Scale')) || 1 };
}
