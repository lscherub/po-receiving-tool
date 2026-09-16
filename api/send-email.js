import { newReportId, isValidReportId, putReportPdf, putReportMeta } from '../lib/report-store.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  try {
    const apiKey = process.env.SMTP2GO_API_KEY;
    const sender = process.env.SMTP2GO_SENDER;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Server missing SMTP2GO_API_KEY.' });
    if (!sender) return res.status(500).json({ ok: false, error: 'Server missing SMTP2GO_SENDER.' });
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Server missing BLOB_READ_WRITE_TOKEN. Connect Blob store and redeploy. Email NOT sent.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { to, subject, textBody, htmlBody, filename, fileblob, mimetype } = body;
    const { reportId, poNumber, vendor, date, selected, storeNames } = body;
    const toList = Array.isArray(to) ? to : (to ? [to] : []);
    const ALLOWED = new Set(['davie@genesisnutrition.ca', 'main@genesisnutrition.ca', 'west@genesisnutrition.ca']);
    const cleanTo = [...new Set(toList.map((s) => String(s || '').trim().toLowerCase()))].filter((e) => ALLOWED.has(e));
    if (cleanTo.length === 0) return res.status(400).json({ ok: false, error: 'No valid internal recipient.' });
    if (!subject || !String(subject).trim()) return res.status(400).json({ ok: false, error: 'Subject required.' });
    if (!fileblob || typeof fileblob !== 'string' || fileblob.length < 1000) {
      return res.status(400).json({ ok: false, error: 'PDF attachment missing or too small.' });
    }
    if (fileblob.length > 20 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'PDF too large (max ~15MB).' });
    const safeFilename = String(filename || 'Receiving_Sheet.pdf').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'Receiving_Sheet.pdf';
    const cleanStores = Array.isArray(storeNames)
      ? [...new Set(storeNames.map((s) => String(s || '').trim().toUpperCase()))].filter((s) => s === 'DAVIE' || s === 'MAIN' || s === 'WEST')
      : [];
    const rid = isValidReportId(reportId) ? reportId : newReportId();
    const selNorm = String(selected || (cleanStores.length > 1 ? 'ALL' : cleanStores[0] || 'ALL')).slice(0, 10);
    let pdfBuffer;
    try { pdfBuffer = Buffer.from(fileblob, 'base64'); } catch (_) { pdfBuffer = null; }
    if (!pdfBuffer || pdfBuffer.length < 500) return res.status(400).json({ ok: false, error: 'Decoded PDF is empty.' });
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const pdfPut = await putReportPdf(rid, pdfBuffer);
    const meta = {
      id: rid, createdAt, expiresAt,
      poNumber: String(poNumber || '').slice(0, 40),
      vendor: String(vendor || '').slice(0, 80),
      date: String(date || '').slice(0, 40),
      selected: selNorm, storeNames: cleanStores,
      recipients: cleanTo, subject: String(subject).slice(0, 200),
      filename: safeFilename, pdfUrl: pdfPut.url, pdfPathname: pdfPut.pathname,
      reportType: 'Store Receiving Sheet',
      accessCount: 0, firstAccessedAt: null, lastAccessedAt: null, accesses: [],
    };
    await putReportMeta(rid, meta);
    let viewUrl = '/view/' + rid;
    try {
      const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() || 'https';
      const host = String((req.headers && req.headers['x-forwarded-host']) || (req.headers && req.headers.host) || '').trim();
      if (host) viewUrl = new URL('/view/' + rid, proto + '://' + host).toString();
    } catch (_) { viewUrl = '/view/' + rid; }
    const textWithLink = String(textBody || subject) + '\n\nView / Download PDF Report (opening this link is logged): ' + viewUrl;
    const htmlWithLink = withViewLinkHtml(htmlBody, textBody, subject, viewUrl);
    const smtpRes = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': apiKey, Accept: 'application/json' },
      body: JSON.stringify({
        sender, to: cleanTo, subject: String(subject).slice(0, 200),
        text_body: textWithLink, html_body: htmlWithLink,
        attachments: [{ filename: safeFilename, fileblob, mimetype: mimetype || 'application/pdf' }],
      }),
    });
    const data = await smtpRes.json().catch(() => ({}));
    if (!smtpRes.ok || (data && data.data && data.data.error)) {
      const msg = (data && data.data && (data.data.error || data.data.error_code)) || ('SMTP2GO failed (HTTP ' + smtpRes.status + ').');
      return res.status(502).json({ ok: false, error: String(msg), requestId: data.request_id || null, reportId: rid, viewUrl });
    }
    const succeeded = data && data.data ? (data.data.succeeded ?? 1) : 1;
    const failed = data && data.data ? (data.data.failed ?? 0) : 0;
    if (failed > 0 && succeeded === 0) {
      return res.status(502).json({ ok: false, error: 'SMTP2GO rejected the email.', failures: (data.data && data.data.failures) || [], reportId: rid, viewUrl });
    }
    return res.status(200).json({ ok: true, message: 'Email sent to ' + cleanTo.join(', '), emailId: (data.data && data.data.email_id) || null, requestId: data.request_id || null, reportId: rid, viewUrl });
  } catch (err) {
    console.error('send-email error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 500) });
  }
}

function escLite(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function withViewLinkHtml(htmlBody, textBody, subject, viewUrl) {
  const base = String(htmlBody || '<p>' + escLite(String(textBody || subject)) + '</p>');
  const safeUrl = String(viewUrl).replace(/"/g, '%22');
  return base
    + '<div style="margin:20px 0 8px;"><a href="' + safeUrl + '" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;font-size:15px;">View / Download PDF Report</a></div>'
    + '<p style="font-size:12px;color:#64748b;margin:0;">Opening this link is logged. Same PDF also attached.</p>'
    + '<p style="font-size:12px;color:#94a3b8;word-break:break-all;">' + escLite(safeUrl) + '</p>';
}
