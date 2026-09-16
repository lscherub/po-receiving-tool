// Blob-only report storage for tracked View/Download links.
// Every read/write goes to Vercel Blob. No in-memory map, global variable,
// or tmp-file fallback — those disappear on cold starts / across instances,
// which caused "Report not found or expired" plus an empty Blob store.
//
// Layout per report id:
//   po-reports/<id>.pdf   actual PDF bytes (uploaded once, never rewritten)
//   po-reports/<id>.json  metadata + access log (rewritten on each view)
// addRandomSuffix:false keeps pathnames deterministic so any instance can
// find them via list({ prefix }) + exact pathname match.
import { put, list, del } from '@vercel/blob';

export const REPORT_DIR = 'po-reports/';
export const REPORT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function newReportId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    }
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const b = crypto.getRandomValues(new Uint8Array(12));
      return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) {}
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

export function isValidReportId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function blobToken() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN missing. Connect a Vercel Blob store and redeploy.');
  return t;
}

export const pdfPathname = (id) => REPORT_DIR + id + '.pdf';
export const metaPathname = (id) => REPORT_DIR + id + '.json';

async function findBlob(pathname) {
  let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await list({ prefix: pathname, limit: 1000, cursor, token: blobToken() });
    const hit = (page.blobs || []).find((b) => b.pathname === pathname);
    if (hit) return hit;
    if (!page.hasMore) return null;
    cursor = page.cursor;
  }
  return null;
}

export async function putReportPdf(id, pdfBuffer) {
  return put(pdfPathname(id), pdfBuffer, {
    access: 'public', contentType: 'application/pdf',
    addRandomSuffix: false, token: blobToken(),
  });
}

export async function putReportMeta(id, meta) {
  return put(metaPathname(id), JSON.stringify(meta), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, cacheControlMaxAge: 0, token: blobToken(),
  });
}

export async function getReportMeta(id) {
  const hit = await findBlob(metaPathname(id));
  if (!hit) return null;
  const sep = hit.url.includes('?') ? '&' : '?';
  const r = await fetch(hit.url + sep + 'cb=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  try { return await r.json(); } catch (_) { return null; }
}

export async function logReportAccess(id, entry) {
  const meta = await getReportMeta(id);
  if (!meta) return null;
  meta.accesses = Array.isArray(meta.accesses) ? meta.accesses : [];
  meta.accesses.push(entry);
  if (meta.accesses.length > 500) meta.accesses = meta.accesses.slice(-500);
  meta.accessCount = meta.accesses.length;
  meta.firstAccessedAt = meta.accesses[0].at;
  meta.lastAccessedAt = entry.at;
  await putReportMeta(id, meta);
  return meta;
}

export function accessEntryFromReq(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim();
  return {
    at: new Date().toISOString(),
    ip: ip || (req.socket && req.socket.remoteAddress) || '',
    ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 200),
  };
}

export async function listAllReportBlobs() {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const page = await list({ prefix: REPORT_DIR, limit: 1000, cursor, token: blobToken() });
    out.push.apply(out, page.blobs || []);
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  return out;
}

export async function deleteBlobs(urls) {
  if (!urls || !urls.length) return;
  await del(urls, { token: blobToken() });
}
