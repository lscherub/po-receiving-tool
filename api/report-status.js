import { loadReport, isValidReportId, storageMode } from '../lib/report-store.js';

// GET /api/report-status?id=<reportId>
// Lets the sender see whether / when a report link was accessed.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use GET.' });
  }
  const id = req.query && req.query.id;
  if (!isValidReportId(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing report id.' });
  }
  const rec = await loadReport(id);
  if (!rec) {
    return res.status(404).json({ ok: false, error: 'Report not found or expired.' });
  }
  const accesses = Array.isArray(rec.accesses) ? rec.accesses : [];
  return res.status(200).json({
    ok: true,
    id: rec.id,
    createdAt: rec.createdAt,
    poNumber: rec.poNumber,
    vendor: rec.vendor,
    date: rec.date,
    selected: rec.selected,
    storeNames: rec.storeNames,
    recipients: rec.recipients,
    subject: rec.subject,
    filename: rec.filename,
    viewUrl: `/report/${rec.id}`,
    storage: storageMode(),
    accessCount: accesses.length,
    firstAccessedAt: accesses.length ? accesses[0].at : null,
    lastAccessedAt: rec.lastAccessedAt || null,
    accesses,
  });
}
