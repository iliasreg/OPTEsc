// Room names, sizes and areas read from the text printed on a plan image (OCR), all in the browser.
// Tesseract (tesseract.js, Apache-2.0) runs locally from ../vendor/tesseract/; nothing is uploaded.
//
//   readPlanText(canvas)  -> { labels, textBoxes, lines }
//   labelsFromLines(lines) is the pure parsing step, exported for tests.
//
// A label is { name, type, x, y, printedArea?, printedFrom? } in canvas pixels.

let workerPromise = null;

async function worker() {
  workerPromise ??= (async () => {
    const { default: Tesseract } = await import('../vendor/tesseract/tesseract.esm.min.js');
    const base = new URL('../vendor/tesseract/', import.meta.url).href;
    const w = await Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js', corePath: base, langPath: base.replace(/\/$/, ''), gzip: true,
    });
    await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' }); // sparse text
    return w;
  })();
  return workerPromise;
}

// Small plans are upscaled so their text is about the size Tesseract reads best.
export async function readPlanText(canvas, onProgress) {
  const k = Math.max(1, Math.min(3, Math.round(2200 / Math.max(canvas.width, canvas.height))));
  let src = canvas;
  if (k > 1) {
    src = document.createElement('canvas');
    src.width = canvas.width * k; src.height = canvas.height * k;
    const ctx = src.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, src.width, src.height);
  }
  onProgress?.('Reading room names…');
  const w = await worker();
  const { data } = await w.recognize(src, {}, { blocks: true, text: false });
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
    const t = l.text.trim();
    if (!t) continue;
    lines.push({ text: t, conf: l.confidence, x0: l.bbox.x0 / k, y0: l.bbox.y0 / k, x1: l.bbox.x1 / k, y1: l.bbox.y1 / k });
  }
  const labels = labelsFromLines(lines);
  await reReadSizes(w, canvas, labels, lines);
  // every confidently read line is text, not linework: keep it out of door and window detection
  const textBoxes = lines.filter((l) => l.conf >= 50).map((l) => [l.x0 - 2, l.y0 - 2, l.x1 + 2, l.y1 + 2]);
  return { labels, textBoxes, lines };
}

// Sparse reading often breaks a size line into fragments or misreads it ("19'9" | "x 151").
// Read the strip under each room name again as one line of size characters only.
async function reReadSizes(w, canvas, labels, lines) {
  const named = labels.filter((l) => l.box);
  if (!named.length) return;
  await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: `0123456789'"’”xX×.,m² ` });
  try {
    for (const l of named) {
      const [x0, y0, x1, y1] = l.box, h = y1 - y0;
      const half = Math.max(x1 - x0, 7 * h) * 0.6, cx = (x0 + x1) / 2;
      const r = { x: Math.max(0, cx - half), y: y1 + h * 0.1, w: 0, h: h * 1.8 };
      r.w = Math.min(canvas.width, cx + half) - r.x;
      r.h = Math.min(canvas.height - r.y, r.h);
      if (r.w < 4 || r.h < 4) continue;
      // keep other text (a neighbour's name) out of the strip
      if (lines.some((o) => o.y0 < r.y + r.h && o.y1 > r.y && o.x0 < r.x + r.w && o.x1 > r.x && /[A-Za-z]{3,}/.test(o.text))) continue;
      const k = Math.min(6, Math.max(1, 48 / h));
      const cv = document.createElement('canvas');
      cv.width = Math.round(r.w * k); cv.height = Math.round(r.h * k);
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
      const { data } = await w.recognize(cv);
      const size = parseSize(data.text.trim(), { minArea: minAreaFor(l.type) });
      if (!size || size.area <= 0.5 || size.area >= 5000) continue;
      // trust the second reading when it is a clean size, or when the first found none
      if (!l.printedArea || !/partly/.test(size.from)) Object.assign(l, { printedArea: Math.round(size.area * 100) / 100, printedFrom: size.from });
    }
  } finally {
    await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  }
}

// ---------- parsing ----------

const VOCAB = [
  // English
  'ROOM', 'BEDROOM', 'BED', 'KITCHEN', 'DINING', 'LIVING', 'LOUNGE', 'FAMILY', 'BATH', 'TOILET', 'POWDER', 'SHOWER',
  'LAUNDRY', 'UTILITY', 'HALL', 'CORRIDOR', 'ENTRY', 'ENTRANCE', 'FOYER', 'VESTIBULE', 'LOBBY', 'OFFICE', 'STUDY',
  'LIBRARY', 'GARAGE', 'PANTRY', 'CLOSET', 'WARDROBE', 'STORAGE', 'STORE', 'MUD', 'PORCH', 'TERRACE', 'BALCONY',
  'DECK', 'PATIO', 'STAIR', 'NOOK', 'BREAKFAST', 'MASTER', 'SUITE', 'GUEST', 'PLAYROOM', 'GYM', 'CELLAR', 'BASEMENT',
  'ATTIC', 'WORKSHOP', 'MEETING', 'CONFERENCE', 'RECEPTION', 'CANTEEN', 'LOCKER', 'CHANGING', 'PRODUCTION',
  'WAREHOUSE', 'LOADING', 'DOCK', 'PLANT', 'SERVER', 'ELECTRICAL', 'MECHANICAL', 'BOILER', 'WORKSHOP', 'CLASSROOM',
  // Swedish, French, German, Spanish, Italian
  'KOK', 'SOVRUM', 'VARDAGSRUM', 'BADRUM', 'TVATT', 'ENTRE', 'KLADKAMMARE', 'MATPLATS', 'BALKONG', 'FORRAD', 'GROVENTRE',
  'CHAMBRE', 'CUISINE', 'SALON', 'SEJOUR', 'SALLE', 'BAIN', 'BUREAU', 'COULOIR', 'ENTREE', 'CELLIER', 'DEGAGEMENT',
  'BUANDERIE', 'SCHLAFZIMMER', 'KUCHE', 'WOHNZIMMER', 'FLUR', 'DIELE', 'ARBEITSZIMMER', 'ABSTELL', 'ZIMMER',
  'COCINA', 'DORMITORIO', 'SALA', 'BANO', 'ESTUDIO', 'CAMERA', 'CUCINA', 'SOGGIORNO', 'BAGNO', 'INGRESSO', 'STUDIO',
];
const SHORT = new Set(['DEN', 'WC', 'BAD', 'KLK', 'SDB', 'LAB', 'GYM', 'MUD', 'WIC', 'BR', 'LR', 'DR']);
const STOP = /\b(?:FIRST|SECOND|THIRD|FOURTH|FIFTH|GROUND|TOP|LOWER|UPPER|MAIN)\s*FLOOR|FLOOR\s*PLAN|POWERED|MATTERPORT|CUBICASA|FLOOR\s*\d|GROSS|INTERNAL|EXCLUDED|TOTAL|SIZES|DIMENSIONS|APPROX|SCALE|NORTH|DRAWING|REVISION|COPYRIGHT/i;

const TYPE_OF = [
  [/BED|SOVRUM|CHAMBRE|SCHLAF|DORMIT|CAMERA|MASTER|GUEST/, 'bedroom'],
  [/KITCHEN|KOK|CUISINE|KUCHE|COCINA|CUCINA|PANTRY/, 'kitchen'],
  [/BATH|TOILET|POWDER|SHOWER|\bWC\b|BADRUM|SDB|BAIN|BANO|BAGNO|\bBAD\b/, 'bathroom'],
  [/RECEPTION\s*ROOM|LIVING|LOUNGE|FAMILY|VARDAGSRUM|SALON|SEJOUR|WOHN|SALA|SOGGIORNO|DINING|MATPLATS|\bDEN\b/, 'living'],
  [/HALL|CORRIDOR|ENTRY|ENTRANCE|FOYER|VESTIBULE|LOBBY|ENTRE|COULOIR|FLUR|DIELE|INGRESSO|STAIR|MUD|DEGAGEMENT/, 'circulation'],
  [/OFFICE|STUDY|LIBRARY|BUREAU|ARBEITS|ESTUDIO|STUDIO|MEETING|CONFERENCE|RECEPTION|CLASSROOM/, 'office'],
  [/STORAGE|STORE|CLOSET|WARDROBE|KLK|KLADKAMMARE|FORRAD|CELLIER|ABSTELL|WIC|LAUNDRY|UTILITY|TVATT|BUANDERIE|CELLAR|ATTIC|BASEMENT/, 'storage'],
  [/GARAGE|LOADING|DOCK|WAREHOUSE/, 'loading_bay'],
  [/TERRACE|BALCONY|DECK|PATIO|PORCH|BALKONG/, 'outdoor'],
  [/PRODUCTION|WORKSHOP|PLANT/, 'production'],
  [/CANTEEN|LOCKER|CHANGING/, 'welfare'],
  [/SERVER|ELECTRICAL|MECHANICAL|BOILER/, 'technical'],
];

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// feet and inches: 11'2" x 10'11", 19'9 x 15'1 ; metric: 322 X 347 (cm), 3.2 x 4.1 (m) ; areas: 13 m2, 120 sq ft
const FT = /(\d{1,2})\s*['’′]\s*(\d{1,2})?\s*["”″°*]?\s*[xX×]\s*(\d{1,2})\s*['’′]\s*(\d{1,2})?/;
const M_DIMS = /\b(\d{1,2}[.,]\d{1,2})\s*[xX×]\s*(\d{1,2}[.,]\d{1,2})\b/;
const CM_DIMS = /\b(\d{2,4})\s*[xX×]\s*(\d{2,4})\b/;
const AREA_M = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m2|m²|m\?|m\b|sq\.?\s*m|sqm)/i;
const AREA_FT = /(\d{2,5}(?:[.,]\d)?)\s*(?:sq\.?\s*ft|ft2|ft²|sf)\b/i;

// one side of a feet-and-inches size; OCR often drops the foot mark ("15'1" read as 151)
function feet(s) {
  let m = /^(\d{1,2})['’′](\d{1,2})?["”″°*]?$/.exec(s);
  if (m && +(m[2] || 0) < 12) return { m: (+m[1] + (+m[2] || 0) / 12) * 0.3048, sure: true };
  m = /^(\d{1,2})(\d{1,2})["”″°*]?$/.exec(s);
  if (m && +m[2] < 12) return { m: (+m[1] + +m[2] / 12) * 0.3048, sure: false, inch: /["”″]$/.test(s) };
  return null;
}

// Smallest believable floor area for a named room, to tell 12'6 x 8'0 read as "126 x 80" from centimetres.
const minAreaFor = (type) => (['bedroom', 'living', 'kitchen', 'office', 'production', 'loading_bay'].includes(type) ? 4 : 0.8);

export function parseSize(text, { minArea = 0 } = {}) {
  let m = FT.exec(text);
  if (m) {
    const a = (+m[1] + (+m[2] || 0) / 12) * 0.3048, b = (+m[3] + (+m[4] || 0) / 12) * 0.3048;
    if (+(m[2] || 0) < 12 && +(m[4] || 0) < 12) return { area: a * b, from: `${m[0].trim()} (feet)` };
  }
  m = /([\d'’′"”″°*]{2,7})\s*[xX×]\s*([\d'’′"”″°*]{2,7})/.exec(text);
  if (m && /['’′"”″]/.test(m[0])) {
    const a = feet(m[1]), b = feet(m[2]);
    if (a && b && (a.sure || b.sure || a.inch || b.inch)) return { area: a.m * b.m, from: `${m[0].trim()} (feet, partly read)` };
  }
  m = M_DIMS.exec(text);
  if (m) return { area: parseFloat(m[1].replace(',', '.')) * parseFloat(m[2].replace(',', '.')), from: `${m[0]} (m)` };
  m = CM_DIMS.exec(text);
  if (m && +m[1] >= 60 && +m[2] >= 60 && +m[1] <= 3000 && +m[2] <= 3000) {
    const area = (m[1] * m[2]) / 1e4;
    if (area >= minArea) return { area, from: `${m[0]} (cm)` };
    const a = feet(m[1]), b = feet(m[2]); // feet and inches with the marks lost
    if (a && b && a.m * b.m >= minArea) return { area: a.m * b.m, from: `${m[0]} (feet, partly read)` };
  }
  m = AREA_FT.exec(text);
  if (m) return { area: parseFloat(m[1].replace(',', '.')) * 0.092903, from: m[0] };
  m = AREA_M.exec(text);
  if (m && /m/i.test(m[0].slice(m[1].length))) return { area: parseFloat(m[1].replace(',', '.')), from: m[0] };
  return null;
}

function roomWord(text) {
  const t = plain(text);
  if (STOP.test(t)) return null;
  const letters = t.replace(/[^A-Z]/g, '');
  const nonSpace = t.replace(/\s/g, '');
  if (letters.length < 2 || letters.length < nonSpace.length * 0.5) return null;
  const words = t.split(/[^A-Z]+/).filter(Boolean);
  if (words.some((w) => SHORT.has(w))) return 'vocab';
  if (VOCAB.some((v) => letters.includes(v))) return 'vocab';
  return letters.length >= 4 && words.length <= 3 ? 'word' : null;
}

function typeOf(name) {
  const t = plain(name);
  for (const [re, type] of TYPE_OF) if (re.test(t)) return type;
  return 'unknown';
}

function tidy(text) {
  // "E NT RYWAY" -> "ENTRYWAY": OCR splits wide letter spacing into fragments
  let t = text.replace(/[|_~=<>{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = t.split(' ');
  if (parts.length > 1 && parts.filter((p) => p.length <= 2 && /\p{L}/u.test(p)).length >= parts.length / 2) t = parts.join('');
  t = t.replace(/\s*\d.*$/, (m) => (/[A-Za-z]{3,}/.test(m) || /^\s*\d{1,2}$/.test(m) ? m : '')).trim(); // drop a trailing size, keep "Bedroom 2"
  t = t.replace(/^[^\p{L}]+/u, ''); // and stray marks or digits in front
  return t.toLowerCase().replace(/(^|[\s/(-])\p{L}/gu, (c) => c.toUpperCase());
}

// Sparse OCR returns widely spaced words as separate lines; join words on one baseline.
function joinWords(lines) {
  const rest = [...lines].sort((a, b) => a.x0 - b.x0);
  const out = [];
  while (rest.length) {
    const l = { ...rest.shift() };
    for (let k = 0; k < rest.length;) {
      const m = rest[k], hgt = Math.max(l.y1 - l.y0, m.y1 - m.y0);
      const overlap = Math.min(l.y1, m.y1) - Math.max(l.y0, m.y0);
      const gap = m.x0 - l.x1;
      if (overlap > 0.6 * Math.min(l.y1 - l.y0, m.y1 - m.y0) && gap > -hgt * 0.3 && gap < hgt * 0.9) {
        l.text += gap < hgt * 0.3 ? m.text : ` ${m.text}`;
        l.conf = Math.min(l.conf, m.conf);
        l.x1 = Math.max(l.x1, m.x1); l.y0 = Math.min(l.y0, m.y0); l.y1 = Math.max(l.y1, m.y1);
        rest.splice(k, 1);
      } else k++;
    }
    out.push(l);
  }
  return out;
}

export function labelsFromLines(rawLines) {
  const lines = joinWords(rawLines);
  const used = new Set();
  const out = [];
  const height = (l) => l.y1 - l.y0;
  const below = (a, b) => b.y0 >= a.y0 + height(a) * 0.5 && b.y0 - a.y1 < Math.max(height(a), height(b)) * 1.6
    && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > -height(a);
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0);
  for (const l of sorted) {
    if (used.has(l)) continue;
    const kind = roomWord(l.text);
    if (!kind || (kind === 'word' ? l.conf < 80 : l.conf < 45)) continue;
    used.add(l);
    const block = [l];
    let name = l.text, nameLine = l;
    const nameLines = [l];
    const minArea = minAreaFor(typeOf(tidy(l.text)));
    let size = parseSize(l.text, { minArea });
    // a second name line right below (BADRUM/ + TVÄTT) and a size line below the name
    for (const m of sorted) {
      if (used.has(m) || !below(block[block.length - 1], m)) continue;
      const s = parseSize(m.text, { minArea });
      if (s && !size) { size = s; used.add(m); block.push(m); continue; }
      // a name broken over two lines: BEDROOM / 2, RECEPTION / ROOM, BADRUM/ / TVÄTT
      if (!s && m.conf >= 45 && /^(ROOM|SUITE|AREA|NOOK|[1-9])$/i.test(m.text.trim()) && !/\d\s*$/.test(name)
        && Math.abs((m.x0 + m.x1) / 2 - (nameLine.x0 + nameLine.x1) / 2) < height(nameLine) * 2) { name += ` ${m.text.trim()}`; nameLine = m; nameLines.push(m); used.add(m); block.push(m); continue; }
      if (!s && roomWord(m.text) && m.conf >= 45 && /\/\s*$/.test(name)) { name += m.text; nameLine = m; nameLines.push(m); used.add(m); block.push(m); }
    }
    const x0 = Math.min(...block.map((b) => b.x0)), x1 = Math.max(...block.map((b) => b.x1));
    const y0 = Math.min(...block.map((b) => b.y0)), y1 = Math.max(...block.map((b) => b.y1));
    const clean = tidy(name);
    if (clean.replace(/[^\p{L}]/gu, '').length < 2) continue;
    const label = { name: clean, type: typeOf(clean), x: (x0 + x1) / 2, y: (y0 + y1) / 2, ocr: Math.round(l.conf), box: [Math.min(...nameLines.map((b) => b.x0)), Math.min(...nameLines.map((b) => b.y0)), Math.max(...nameLines.map((b) => b.x1)), Math.max(...nameLines.map((b) => b.y1))] };
    if (size && size.area > 0.5 && size.area >= minArea * 0.5 && size.area < 5000) Object.assign(label, { printedArea: Math.round(size.area * 100) / 100, printedFrom: size.from });
    out.push(label);
  }
  // sizes with no readable name next to them (a script Tesseract can't read): still a printed area
  for (const l of sorted) {
    if (used.has(l) || l.conf < 60 || /[A-Za-z]{3,}/.test(l.text)) continue;
    const size = parseSize(l.text);
    if (!size || /partly/.test(size.from) || size.area <= 0.5 || size.area >= 5000) continue;
    out.push({ name: null, type: null, x: (l.x0 + l.x1) / 2, y: (l.y0 + l.y1) / 2, ocr: Math.round(l.conf), printedArea: Math.round(size.area * 100) / 100, printedFrom: size.from });
  }
  return out;
}
