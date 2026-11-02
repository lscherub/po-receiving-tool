import { timingSafeEqual } from 'crypto';
import { newReportId, isValidReportId, putReportPdf, putReportMeta, getReportMeta } from '../lib/report-store.js';

const ALLOWED = new Set(['davie@genesisnutrition.ca', 'east@genesisnutrition.ca', 'west@genesisnutrition.ca']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-report-password, Authorization');
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

    // Handle Resend Order Sheet from Reports page
    const resendId = body.resendReportId || (body.action === 'resend' ? body.reportId : null);
    if (resendId) {
      if (!isValidReportId(resendId)) {
        return res.status(400).json({ ok: false, error: 'Invalid report ID.' });
      }
      const expectedPw = process.env.REPORT_PASSWORD || '';
      if (expectedPw) {
        const suppliedPw = getSuppliedPassword(req, body);
        if (!suppliedPw || !passwordsEqual(suppliedPw, expectedPw)) {
          return res.status(401).json({ ok: false, error: 'Unauthorized. Report password required.' });
        }
      }
      const meta = await getReportMeta(resendId);
      if (!meta) {
        return res.status(404).json({ ok: false, error: 'Report not found or expired.' });
      }
      const toList = Array.isArray(meta.recipients) ? meta.recipients : [];
      const cleanTo = [...new Set(toList.map((s) => String(s || '').trim().toLowerCase()))].filter((e) => ALLOWED.has(e));
      if (cleanTo.length === 0) {
        return res.status(400).json({ ok: false, error: 'No valid internal recipient found for this report.' });
      }
      const subject = String(meta.subject || '').trim() || ('PO #' + (meta.poNumber || '') + ' (' + (meta.vendor || '') + ') - Receiving Sheet');
      const textBody = meta.textBody || formatDefaultEmailBody(meta);
      const htmlBody = meta.htmlBody || ('<p>' + escLite(textBody).replace(/\n/g, '<br>') + '</p>');
      const viewUrl = buildViewUrl(req, resendId);
      const textWithLink = String(textBody || subject) + '\n\nView / Download PDF Report (opening this link is logged): ' + viewUrl;
      const htmlWithLink = withViewLinkHtml(htmlBody, textBody, subject, viewUrl);

      const smtpRes = await sendSmtp2go({ apiKey, sender, cleanTo, subject, textWithLink, htmlWithLink });
      if (!smtpRes.ok) {
        return res.status(smtpRes.status || 502).json({
          ok: false,
          error: smtpRes.error,
          requestId: smtpRes.requestId || null,
          failures: smtpRes.failures || [],
          reportId: resendId,
          viewUrl,
        });
      }
      return res.status(200).json({
        ok: true,
        message: 'Order Sheet successfully resent.',
        emailId: smtpRes.emailId || null,
        requestId: smtpRes.requestId || null,
        reportId: resendId,
        viewUrl,
      });
    }

    // Original flow: send internal email for newly generated PO sheet
    const { to, subject, textBody, htmlBody, filename, fileblob } = body;
    const { reportId, poNumber, vendor, date, selected, storeNames } = body;
    const toList = Array.isArray(to) ? to : (to ? [to] : []);
    const cleanTo = [...new Set(toList.map((s) => String(s || '').trim().toLowerCase()))].filter((e) => ALLOWED.has(e));
    if (cleanTo.length === 0) return res.status(400).json({ ok: false, error: 'No valid internal recipient.' });
    if (!subject || !String(subject).trim()) return res.status(400).json({ ok: false, error: 'Subject required.' });
    if (!fileblob || typeof fileblob !== 'string' || fileblob.length < 1000) {
      return res.status(400).json({ ok: false, error: 'PDF data missing or too small.' });
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
      textBody: String(textBody || '').slice(0, 4000),
      htmlBody: String(htmlBody || '').slice(0, 8000),
      filename: safeFilename, pdfUrl: pdfPut.url, pdfPathname: pdfPut.pathname,
      reportType: 'Store Receiving Sheet',
      accessCount: 0, firstAccessedAt: null, lastAccessedAt: null, accesses: [],
    };
    await putReportMeta(rid, meta);
    const viewUrl = buildViewUrl(req, rid);
    const textWithLink = String(textBody || subject) + '\n\nView / Download PDF Report (opening this link is logged): ' + viewUrl;
    const htmlWithLink = withViewLinkHtml(htmlBody, textBody, subject, viewUrl);

    const smtpRes = await sendSmtp2go({ apiKey, sender, cleanTo, subject, textWithLink, htmlWithLink });
    if (!smtpRes.ok) {
      return res.status(smtpRes.status || 502).json({
        ok: false,
        error: smtpRes.error,
        requestId: smtpRes.requestId || null,
        failures: smtpRes.failures || [],
        reportId: rid,
        viewUrl,
      });
    }
    return res.status(200).json({
      ok: true,
      message: 'Email sent to ' + cleanTo.join(', '),
      emailId: smtpRes.emailId || null,
      requestId: smtpRes.requestId || null,
      reportId: rid,
      viewUrl,
    });
  } catch (err) {
    console.error('send-email error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 500) });
  }
}

async function sendSmtp2go({ apiKey, sender, cleanTo, subject, textWithLink, htmlWithLink }) {
  const smtpRes = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': apiKey, Accept: 'application/json' },
    body: JSON.stringify({
      sender, to: cleanTo, subject: String(subject).slice(0, 200),
      text_body: textWithLink, html_body: htmlWithLink,
    }),
  });
  const data = await smtpRes.json().catch(() => ({}));
  if (!smtpRes.ok || (data && data.data && data.data.error)) {
    const msg = (data && data.data && (data.data.error || data.data.error_code)) || ('SMTP2GO failed (HTTP ' + smtpRes.status + ').');
    return { ok: false, status: 502, error: String(msg), requestId: data.request_id || null };
  }
  const succeeded = data && data.data ? (data.data.succeeded ?? 1) : 1;
  const failed = data && data.data ? (data.data.failed ?? 0) : 0;
  if (failed > 0 && succeeded === 0) {
    return { ok: false, status: 502, error: 'SMTP2GO rejected the email.', failures: (data.data && data.data.failures) || [] };
  }
  return { ok: true, emailId: (data.data && data.data.email_id) || null, requestId: data.request_id || null };
}

function buildViewUrl(req, rid) {
  let viewUrl = '/view/' + rid;
  try {
    const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() || 'https';
    const host = String((req.headers && req.headers['x-forwarded-host']) || (req.headers && req.headers.host) || '').trim();
    if (host) viewUrl = new URL('/view/' + rid, proto + '://' + host).toString();
  } catch (_) { viewUrl = '/view/' + rid; }
  return viewUrl;
}

function formatDefaultEmailBody(meta) {
  const lines = ['Hi team,', ''];
  const poInfo = [meta.poNumber ? 'PO #' + meta.poNumber : '', meta.vendor ? '(' + meta.vendor + (meta.date ? ', ' + meta.date : '') + ')' : (meta.date || '')].filter(Boolean).join(' ');
  const storeScope = meta.selected === 'ALL'
    ? 'covering: ' + ((meta.storeNames && meta.storeNames.length) ? meta.storeNames.join(', ') : 'All Stores')
    : 'for ' + (meta.selected || 'store') + ' store';
  lines.push('Please review the purchase order ' + (poInfo ? poInfo + ' ' : '') + storeScope + ' using the link below.');
  lines.push('');
  lines.push('Please check all expiry dates and customer requests on arrival.');
  lines.push('');
  lines.push('Thanks,');
  return lines.join('\n');
}

function getSuppliedPassword(req, body) {
  const h = req.headers || {};
  const fromHeader = h['x-report-password'] || h['X-Report-Password'] || h['x-report-Password'];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  if (body && typeof body.password === 'string' && body.password) return body.password;
  const auth = String(h.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return '';
}

function passwordsEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch (_) {
    return String(a) === String(b);
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
    + '<p style="font-size:12px;color:#64748b;margin:0;">Opening this link is logged. Please use the button above to view/download the PDF.</p>'
    + '<p style="font-size:12px;color:#94a3b8;word-break:break-all;">' + escLite(safeUrl) + '</p>';
}
