'use strict';

// Car thumbnails: the driver's uploaded photo, or a side-view illustration
// whose body style is guessed from the model name, painted in their colour.

const CAR_COLORS = [
  { hex: '#f4f5f2', name: 'White' },
  { hex: '#1f2224', name: 'Black' },
  { hex: '#c3c8cc', name: 'Silver' },
  { hex: '#6c757b', name: 'Grey' },
  { hex: '#2f5fb3', name: 'Blue' },
  { hex: '#c0392b', name: 'Red' },
  { hex: '#2e7d5b', name: 'Green' },
  { hex: '#e3b23c', name: 'Yellow' },
  { hex: '#e07a2e', name: 'Orange' },
];

// Keywords are matched against the lower-cased model name, most specific first.
const BODY_KEYWORDS = [
  ['pickup', ['f-150', 'lightning', 'cybertruck', 'r1t', 'silverado', 'hummer', 'sierra', 'ram 1500']],
  ['hatch', ['leaf', 'bolt ev', 'i3', 'zoe', 'id.3', 'id3', 'mini', 'e-208', 'mg4', 'corsa', '500e', 'fiat 500', 'kona', 'born', 'e-golf', 'dolphin', 'spring', 'honda e', 'megane']],
  ['sedan', ['model 3', 'model s', 'ioniq 6', 'polestar 2', 'taycan', 'i4', 'i5', 'i7', 'eqe', 'eqs', 'lucid', 'seal', 'e-tron gt', 'et5', 'et7']],
  ['suv', ['model y', 'model x', 'id.4', 'id4', 'ev6', 'ev9', 'ioniq 5', 'mach-e', 'ariya', 'q4', 'q8', 'e-tron', 'ix', 'eqa', 'eqb', 'xc40', 'ex30', 'ex90', 'enyaq', 'bolt euv', 'polestar 3', 'polestar 4', 'r1s', 'solterra', 'bz4x', 'niro', 'atto', 'equinox', 'blazer', 'lyriq', 'prologue', 'zs']],
];

function bodyType(model) {
  const m = String(model || '').toLowerCase();
  for (const [type, words] of BODY_KEYWORDS) if (words.some((w) => m.includes(w))) return type;
  return 'suv'; // most EVs today are crossovers
}

// Side profiles facing left, drawn in a 120x60 box. [body, windows, wheel x positions, wheel y, wheel r]
const SHAPES = {
  sedan: {
    body: 'M8 41 L8 35 Q9 29 21 28 L38 26 Q49 15 64 14 L80 14 Q92 16 101 26 L110 28 Q115 30 115 36 L115 41 Z',
    windows: 'M43 26 Q51 18 62 17 L70 17 L70 26 Z M73 17 L80 17 Q89 18 96 26 L73 26 Z',
    wheels: [29, 93], wy: 41, wr: 8,
  },
  suv: {
    body: 'M7 43 L7 31 Q8 26 20 25 L32 24 Q40 12 51 11 L93 11 Q101 12 105 22 L110 25 Q115 27 115 34 L115 43 Z',
    windows: 'M38 24 Q44 15 53 14 L70 14 L70 24 Z M73 14 L91 14 Q97 15 100 24 L73 24 Z',
    wheels: [29, 92], wy: 43, wr: 9,
  },
  hatch: {
    body: 'M12 42 L12 33 Q13 27 25 26 L36 25 Q45 13 57 12 L91 12 Q99 13 101 22 L104 33 L104 42 Z',
    windows: 'M42 25 Q49 16 58 15 L71 15 L71 25 Z M74 15 L90 15 Q95 16 97 25 L74 25 Z',
    wheels: [31, 87], wy: 42, wr: 8.5,
  },
  pickup: {
    body: 'M5 43 L5 31 Q6 26 17 25 L29 24 Q37 12 47 11 L65 11 Q70 12 72 24 L115 24 L115 43 Z',
    windows: 'M35 24 Q41 15 49 14 L64 14 Q67 15 68 24 Z',
    wheels: [26, 95], wy: 43, wr: 9,
  },
};

// Stable default colour per driver until they pick one.
function defaultCarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAR_COLORS[h % CAR_COLORS.length].hex;
}

function carSvg(model, color) {
  const s = SHAPES[bodyType(model)];
  const wheels = s.wheels
    .map((x) => `<circle cx="${x}" cy="${s.wy}" r="${s.wr}" fill="#25292b"/><circle cx="${x}" cy="${s.wy}" r="${s.wr * 0.42}" fill="#a9b2b6"/>`)
    .join('');
  return `<svg viewBox="0 0 120 56" aria-hidden="true">
    <ellipse cx="60" cy="${s.wy + s.wr - 1}" rx="54" ry="3" fill="#000" opacity=".12"/>
    <path class="car-body" d="${s.body}" fill="${color}" stroke="#000" stroke-opacity=".28" stroke-width="1" stroke-linejoin="round"/>
    <path d="${s.windows}" fill="#cfe3ee" opacity=".9"/>
    ${wheels}
  </svg>`;
}

/** Thumbnail HTML for a driver ({ id, name, car_model, car_color, photo_version }). */
function carThumb(d, size = '') {
  const label = esc(d.car_model);
  if (d.photo_version) {
    return `<img class="car-thumb ${size}" src="/api/users/${d.id}/photo?v=${encodeURIComponent(d.photo_version)}" alt="${label}" loading="lazy" />`;
  }
  return `<span class="car-thumb ${size}" role="img" aria-label="${label}">${carSvg(d.car_model, d.car_color || defaultCarColor(d.name))}</span>`;
}

/** Crop and shrink an image file to a small JPEG data URL for upload. */
async function resizeCarPhoto(file, w = 240, h = 160) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't read that image. Try a JPG or PNG.");
  }
  const scale = Math.max(w / bitmap.width, h / bitmap.height);
  const sw = w / scale;
  const sh = h / scale;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.82);
}
