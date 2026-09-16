// GET /api/cron-cleanup — Vercel Cron deletes report blobs older than ~14d.
// Auth: Vercel sends Authorization: Bearer <CRON_SECRET> when CRON_SECRET is
// set; also allow user-agent vercel-cron/1.0 so local/manual runs work.
import { listAllReportBlobs, deleteBlobs, REPORT_TTL_MS } from '../lib/report-store.js';

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
    const stale = blobs.filter((b) => {
      const t = b.uploadedAt ? new Date(b.uploadedAt).getTime() : NaN;
      return !isNaN(t) && t < cutoff;
    });
    await deleteBlobs(stale.map((b) => b.url));
    return res.status(200).json({ ok: true, scanned: blobs.length, deleted: stale.length, cutoffDays: 14 });
  } catch (err) {
    console.error('cleanup error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}
