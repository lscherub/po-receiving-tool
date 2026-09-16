// GET /api/cron-cleanup — Vercel Cron deletes report blobs older than ~14d.
// Auth: Vercel sends Authorization: Bearer <CRON_SECRET> when CRON_SECRET is
// set; also allow user-agent vercel-cron/1.0 so local/manual runs work.
// Retention is based on the report's createdAt inside its metadata JSON
// (stable across views), falling back to Blob uploadedAt. Only touches
// po-reports/* blobs — nothing else in the store.
import { listAllReportBlobs, deleteBlobs, REPORT_DIR, REPORT_TTL_MS } from '../lib/report-store.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  const ua = String(req.headers['user-agent'] || '');
  const sched = String(req.headers['x-vercel-cron-schedule'] || '');
  const authorized = secret ? (auth === 'Bearer ' + secret) : ua.includes('vercel-cron');
  if (!authorized && !(ua.includes('vercel-cron') && sched)) {
    if (secret) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  try {
    const blobs = await listAllReportBlobs();
    const cutoff = Date.now() - REPORT_TTL_MS;
    const byPath = new Map(blobs.map((b) => [b.pathname, b]));
    const jsonBlobs = blobs.filter((b) =>
      b.pathname && b.pathname.startsWith(REPORT_DIR) && b.pathname.endsWith('.json'));
    // createdAt lives inside each metadata JSON; fetch only those (bounded).
    const metas = await Promise.all(jsonBlobs.slice(0, 1000).map(async (b) => {
      try {
        const sep = b.url.includes('?') ? '&' : '?';
        const r = await fetch(b.url + sep + 'cb=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return { id: null, createdAt: null, blob: b };
        const m = await r.json().catch(() => null);
        return { id: (m && m.id) || null, createdAt: (m && m.createdAt) || null, blob: b };
      } catch (_) { return { id: null, createdAt: null, blob: b }; }
    }));
    const staleUrls = [];
    for (const { id, createdAt, blob } of metas) {
      let t = createdAt ? new Date(createdAt).getTime() : NaN;
      if (isNaN(t)) t = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : NaN;
      if (isNaN(t) || t >= cutoff) continue;
      staleUrls.push(blob.url);
      // Delete the paired PDF for the same report id, if present.
      if (id) {
        const pdf = byPath.get(REPORT_DIR + id + '.pdf');
        if (pdf) staleUrls.push(pdf.url);
      }
    }
    // Include stale PDFs whose JSON is already gone (orphans), same cutoff.
    for (const b of blobs) {
      if (!b.pathname || !b.pathname.startsWith(REPORT_DIR) || !b.pathname.endsWith('.pdf')) continue;
      if (staleUrls.includes(b.url)) continue;
      const id = b.pathname.slice(REPORT_DIR.length, -4);
      if (byPath.get(REPORT_DIR + id + '.json')) continue;
      const t = b.uploadedAt ? new Date(b.uploadedAt).getTime() : NaN;
      if (!isNaN(t) && t < cutoff) staleUrls.push(b.url);
    }
    await deleteBlobs([...new Set(staleUrls)]);
    return res.status(200).json({ ok: true, scanned: blobs.length, deleted: [...new Set(staleUrls)].length, cutoffDays: 14 });
  } catch (err) {
    console.error('cleanup error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}
