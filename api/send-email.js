import { newReportId, saveReport, isValidReportId } from '../lib/report-store.js';

export default async function handler(req, res) {
  // ---- CORS (same-origin on Vercel is fine; this allows preview/testing) ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    // ---- Server-only secrets (never exposed to browser) ----
    const apiKey = process.env.SMTP2GO_API_KEY;
    const sender = process.env.SMTP2GO_SENDER; // e.g. orders@genesisnutrition.ca (must be a verified sender in SMTP2GO)
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'Server is missing SMTP2GO_API_KEY env var.' });
    }
    if (!sender) {
      return res.status(500).json({ ok: false, error: 'Server is missing SMTP2GO_SENDER env var.' });
    }

    // ---- Parse + validate body ----
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const {
      to, subject, textBody, htmlBody, filename, fileblob, mimetype,
      // NEW (optional, from the email modal): tracked report link support.
      reportId, poNumber, vendor, date, selected, storeNames,
    } = body;

    const toList = Array.isArray(to) ? to : (to ? [to] : []);
    // Allowlist: internal store mailboxes only. Prevents this endpoint
    // from being abused as an open relay.
    const ALLOWED = new Set([
      'davie@genesisnutrition.ca',
      'east@genesisnutrition.ca',
      'west@genesisnutrition.ca',
    ]);
    const cleanTo = [...new Set(toList.map((s) => String(s || '').trim().toLowerCase()))]
      .filter((e) => ALLOWED.has(e));

    if (cleanTo.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid internal recipient. Use davie@genesisnutrition.ca, east@genesisnutrition.ca, or west@genesisnutrition.ca.',
      });
    }
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ ok: false, error: 'Subject is required.' });
    }
    if (!fileblob || typeof fileblob !== 'string' || fileblob.length < 1000) {
      return res.status(400).json({ ok: false, error: 'PDF attachment (base64 fileblob) is missing or too small.' });
    }
    // ~15MB base64 cap keeps us safely under SMTP2GO 50MB total + Vercel 4.5MB function response
    // (request limit is higher, but keep PDFs sane: html2pdf sheets are usually 0.2–3MB base64).
    if (fileblob.length > 20 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'PDF attachment too large (max ~15MB).' });
    }

    const safeFilename = String(filename || 'Receiving_Sheet.pdf').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'Receiving_Sheet.pdf';

    // ---- NEW: persist the report so /report/<id> shows the right PDF ----
    // The frontend generates the exact same PDF bytes it attaches; we store a
    // copy server-side keyed by reportId so the "View Report" link always
    // renders the correct store scope (incl. "All Stores"). If the frontend
    // did not send a reportId (old cached page), fall back to a server id —
    // the email still goes out normally.
    const cleanStores = Array.isArray(storeNames)
      ? [...new Set(storeNames.map((s) => String(s || '').trim().toUpperCase()))]
          .filter((s) => s === 'DAVIE' || s === 'MAIN' || s === 'WEST')
      : [];
    const rid = isValidReportId(reportId) ? reportId : newReportId();
    const createdAt = new Date().toISOString();
    let viewUrlPath = null;
    try {
      await saveReport({
        id: rid,
        createdAt,
        poNumber: String(poNumber || '').slice(0, 40),
        vendor: String(vendor || '').slice(0, 80),
        date: String(date || '').slice(0, 40),
        selected: String(selected || (cleanStores.length > 1 ? 'ALL' : cleanStores[0] || 'ALL')).slice(0, 10),
        storeNames: cleanStores,
        recipients: cleanTo,
        subject: String(subject).slice(0, 200),
        filename: safeFilename,
        pdfBase64: fileblob,
        accesses: [],
        lastAccessedAt: null,
      });
      viewUrlPath = `/report/${rid}`;
    } catch (storeErr) {
      // Storage must never block the email itself; log and continue.
      console.error('report store failed (email still sending):', storeErr);
      viewUrlPath = null;
    }
    const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() || 'https';
    const host = String((req.headers && req.headers['x-forwarded-host']) || (req.headers && req.headers.host) || '').trim();
    const viewUrl = viewUrlPath && host ? `${proto}://${host}${viewUrlPath}` : viewUrlPath;

    // ---- Call SMTP2GO (key sent server-to-server only) ----
    const smtpRes = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Smtp2go-Api-Key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender,
        to: cleanTo,
        subject: String(subject).slice(0, 200),
        text_body: viewUrl
          ? `${String(textBody || subject)}\n\nView Report (opening this link is logged): ${viewUrl}`
          : String(textBody || subject),
        html_body: viewUrl ? withViewLinkHtml(htmlBody, textBody, subject, viewUrl) : String(htmlBody || `<p>${escapeHtmlLite(String(textBody || subject))}</p>`),
        attachments: [
          {
            filename: safeFilename,
            fileblob, // pure base64, no data: prefix — attachment KEPT as requested
            mimetype: mimetype || 'application/pdf',
          },
        ],
      }),
    });

    const data = await smtpRes.json().catch(() => ({}));

    if (!smtpRes.ok || (data && data.data && data.data.error)) {
      const msg =
        (data && data.data && (data.data.error || data.data.error_code)) ||
        `SMTP2GO request failed (HTTP ${smtpRes.status}).`;
      return res.status(502).json({ ok: false, error: String(msg), requestId: data.request_id || null });
    }

    const succeeded = data && data.data ? (data.data.succeeded ?? 1) : 1;
    const failed = data && data.data ? (data.data.failed ?? 0) : 0;
    if (failed > 0 && succeeded === 0) {
      return res.status(502).json({
        ok: false,
        error: 'SMTP2GO rejected the email.',
        failures: (data.data && data.data.failures) || [],
      });
    }

    return res.status(200).json({
      ok: true,
      message: `Email sent to ${cleanTo.join(', ')}`,
      emailId: (data.data && data.data.email_id) || null,
      requestId: data.request_id || null,
      reportId: viewUrlPath ? rid : null,
      viewUrl,
    });
  } catch (err) {
    console.error('send-email error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error sending email.' });
  }
}

function escapeHtmlLite(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Appends a "View Report" button to the HTML body. The frontend already sends
// a plain <p> body; we keep it and add the button so nothing else changes.
function withViewLinkHtml(htmlBody, textBody, subject, viewUrl) {
  const base = String(htmlBody || `<p>${escapeHtmlLite(String(textBody || subject))}</p>`);
  const safeUrl = String(viewUrl).replace(/"/g, '%22');
  return `${base}<p style="margin:16px 0 0;"><a href="${safeUrl}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">View Report</a></p><p style="font-size:12px;color:#64748b;">Opening this link is logged by the sender.</p>`;
}
