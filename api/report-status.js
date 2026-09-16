// GET /api/report-status?id=<id> — was/when accessed + send metadata.
import { isValidReportId, getReportMeta } from '../lib/report-store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Use GET.' });
  const id = req.query && req.query.id;
  if (!isValidReportId(id)) return res.status(400).json({ ok: false, error: 'Invalid id.' });
  const m = await getReportMeta(id);
  if (!m) return res.status(404).json({ ok: false, error: 'Report not found or expired.' });
  const accesses = Array.isArray(m.accesses) ? m.accesses : [];
  return res.status(200).json({
    ok: true, id: m.id, createdAt: m.createdAt, expiresAt: m.expiresAt,
    reportType: m.reportType || 'Store Receiving Sheet',
    poNumber: m.poNumber, vendor: m.vendor, date: m.date,
    selected: m.selected, storeNames: m.storeNames, recipients: m.recipients,
    subject: m.subject, filename: m.filename, viewUrl: '/view/' + m.id,
    storage: 'blob', accessCount: accesses.length,
    viewed: accesses.length > 0,
    firstAccessedAt: accesses.length ? accesses[0].at : null,
    lastAccessedAt: m.lastAccessedAt || null, accesses,
  });
}
