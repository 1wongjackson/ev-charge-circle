// Finds a freely licensed photo of a car model via Wikipedia / Wikimedia
// Commons, with the author and licence needed to credit it. Results (including
// "nothing found") are cached in the car_images table, keyed by model name.

import { all } from './db.js';

const USER_AGENT = 'EVChargeCircle/1.0 (https://github.com/1wongjackson/ev-charge-circle)';
const API = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&';
const RETRY_NOT_FOUND_MS = 7 * 24 * 3600_000;
const RETRY_ERROR_MS = 10 * 60_000;
// The article's short description must say it's a vehicle, so "my old leaf"
// doesn't come back with a photo of a fern.
const VEHICLE = /\b(car|vehicle|automobile|suv|crossover|pickup|truck|hatchback|sedan|saloon|minivan|van|roadster|coupe|estate)s?\b/i;

await all(`
  CREATE TABLE IF NOT EXISTS car_images (
    model_key  TEXT PRIMARY KEY,
    title      TEXT,
    image_url  TEXT,
    file_url   TEXT,
    artist     TEXT,
    license    TEXT,
    fetched_at TEXT NOT NULL
  )`);

export const modelKey = (model) => String(model || '').trim().toLowerCase().replace(/\s+/g, ' ');

const inFlight = new Map();
const lastError = new Map();

async function wiki(query) {
  const res = await fetch(API + query, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  return res.json();
}

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function lookup(model) {
  const search = await wiki(
    `action=query&generator=search&gsrsearch=${encodeURIComponent(model)}&gsrlimit=5&gsrnamespace=0&prop=pageimages|description&piprop=name`
  );
  const pages = (search.query?.pages || []).sort((a, b) => a.index - b.index);
  const page = pages.find((p) => p.pageimage && !/\.svg$/i.test(p.pageimage) && VEHICLE.test(p.description || ''));
  if (!page) return null;

  const file = await wiki(
    `action=query&titles=${encodeURIComponent('File:' + page.pageimage)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=320`
  );
  const info = file.query?.pages?.[0]?.imageinfo?.[0];
  if (!info?.thumburl) return null;
  const meta = info.extmetadata || {};
  return {
    title: page.title,
    image_url: info.thumburl,
    file_url: info.descriptionurl,
    artist: stripHtml(meta.Artist?.value).slice(0, 120) || 'Unknown author',
    license: stripHtml(meta.LicenseShortName?.value).slice(0, 60) || 'see file page',
  };
}

/** Look a model up and cache the result. Resolves to true if a photo was found. */
export function resolveCarImage(model) {
  const key = modelKey(model);
  if (!key) return Promise.resolve(false);
  if (inFlight.has(key)) return inFlight.get(key);
  if (Date.now() - (lastError.get(key) || 0) < RETRY_ERROR_MS) return Promise.resolve(false);

  const job = (async () => {
    try {
      const found = await lookup(model);
      await all(
        `INSERT INTO car_images(model_key, title, image_url, file_url, artist, license, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (model_key) DO UPDATE SET title = excluded.title, image_url = excluded.image_url,
           file_url = excluded.file_url, artist = excluded.artist, license = excluded.license, fetched_at = excluded.fetched_at`,
        [key, found?.title ?? null, found?.image_url ?? null, found?.file_url ?? null, found?.artist ?? null, found?.license ?? null, new Date().toISOString()]
      );
      return Boolean(found);
    } catch (err) {
      lastError.set(key, Date.now());
      console.warn(`Car photo lookup failed for "${model}": ${err.message}`);
      return false;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/**
 * Cached photos for the given models, as Map(model_key -> photo, null if none
 * was found, or undefined while the first lookup is still running).
 * Models never looked up (or "not found" long ago) are queued in the
 * background; onFound runs if any of those turn up a photo.
 */
export async function carImagesFor(models, onFound) {
  const keys = [...new Set(models.map(modelKey).filter(Boolean))];
  const rows = keys.length ? await all('SELECT * FROM car_images WHERE model_key = ANY($1)', [keys]) : [];
  const byKey = new Map(rows.map((r) => [r.model_key, r]));
  const result = new Map();
  const pending = [];
  for (const model of new Set(models)) {
    const row = byKey.get(modelKey(model));
    const stale = row && !row.image_url && Date.now() - Date.parse(row.fetched_at) > RETRY_NOT_FOUND_MS;
    if (!row || stale) pending.push(resolveCarImage(model));
    result.set(
      modelKey(model),
      !row ? undefined
        : row.image_url ? { url: row.image_url, file_url: row.file_url, title: row.title, artist: row.artist, license: row.license }
        : null
    );
  }
  if (pending.length && onFound) {
    Promise.all(pending).then((found) => found.some(Boolean) && onFound());
  }
  return result;
}
