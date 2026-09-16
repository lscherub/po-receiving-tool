// GET /api/reports — head-office report history (password protected).
// Auth: client sends the shared REPORT_PASSWORD as header
//   x-report-password: <password> (preferred), or POST JSON { password },
//   or Authorization: Bearer <password>.
// The secret lives ONLY in process.env.REPORT_PASSWORD (Vercel env var).
// Response: [{ id, createdAt, poNumber, vendor, date, selected, storeNames,
//   recipients, subject, filename, viewUrl, accessCount, viewed,
//   firstAccessedAt, lastAccessedAt }] newest first. Blob-backed, survives restarts.
import { listReportMetas, toReportSummary } from '../lib/report-store.js';
import { timingSafeEqual } from 'crypto';

function getSuppliedPassword(req, body) {
  const h = req.headers || {};
  const fromHeader =
    h['x-report-password'] || h['X-Report-Password'] || h['x-report-Password'];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  if (body && typeof body.password === 'string' && body.password) return body.password;
  const auth = String(h.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return '';
}

function passwordsEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) {
    return false;
  }
  try {
    return timingSafeEqual(ab, bb);
  } catch (_) {
    return String(a) === String(b);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-report-password, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use GET or POST.' });
  }

  const expected = process.env.REPORT_PASSWORD || '';
  if (!expected) {
    return res.status(500).json({
      ok: false,
      error: 'Server missing REPORT_PASSWORD. Set it in Vercel env vars and redeploy.',
    });
  }

  let body = {};
  if (req.method === 'POST') {
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch (_) {
      body = {};
    }
  }

  const supplied = getSuppliedPassword(req, body);
  if (!supplied || !passwordsEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: 'Wrong password.' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'Server missing BLOB_READ_WRITE_TOKEN. Connect Blob store and redeploy.',
    });
  }

  try {
    let limit = 300;
    const rawLimit = req.query && (req.query.limit || (body && body.limit));
    if (rawLimit != null) {
      const n = parseInt(String(rawLimit), 10);
      if (!isNaN(n)) limit = Math.max(1, Math.min(n, 1000));
    }
    const metas = await listReportMetas(limit);
    const reports = metas.map(toReportSummary);
    return res.status(200).json({ ok: true, count: reports.length, reports });
  } catch (err) {
    console.error('reports list error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}
