import { loadReport, logReportAccess, isValidReportId, accessEntryFromReq } from '../../lib/report-store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed. Use GET.');
  }

  const id = req.query && req.query.id;
  if (!isValidReportId(id)) {
    return res.status(400).send('Invalid report id.');
  }

  // Raw PDF bytes (used by the viewer iframe + Download button).
  // The iframe's referer is the viewer page itself, which already logged the
  // access — so skip double-counting in that case.
  if (req.query.format === 'pdf') {
    const rec = await loadReport(id);
    if (!rec || !rec.pdfBase64) {
      return res.status(404).send('Report not found or expired.');
    }
    const referer = String(req.headers.referer || req.headers.referrer || '');
    if (referer.indexOf(`/report/${id}`) === -1) {
      try {
        await logReportAccess(id, accessEntryFromReq(req));
      } catch (_) {
        // logging must never break viewing
      }
    }
    let buf;
    try {
      buf = Buffer.from(rec.pdfBase64, 'base64');
    } catch (_) {
      return res.status(500).send('Could not decode report PDF.');
    }
    const safeName = String(rec.filename || 'Receiving_Sheet.pdf').replace(/"/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${safeName}"`
    );
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).send(buf);
  }

  // Viewer page: logs the access, then displays the correct PDF.
  const rec = await loadReport(id);
  if (!rec) {
    return res
      .status(404)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(notFoundHtml());
  }
  let viewCount = 0;
  try {
    const updated = await logReportAccess(id, accessEntryFromReq(req));
    viewCount = updated && updated.accesses ? updated.accesses.length : 0;
  } catch (_) {
    viewCount = rec.accesses ? rec.accesses.length : 0;
  }

  return res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(viewerHtml(rec, id, viewCount));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function viewerHtml(rec, id, viewCount) {
  const title = `PO #${rec.poNumber || '?'} (${rec.vendor || '?'}) - Receiving Sheet`;
  const scope =
    rec.selected === 'ALL'
      ? 'All Stores' + (rec.storeNames && rec.storeNames.length ? ` (${rec.storeNames.join(', ')})` : '')
      : rec.selected || '';
  const pdfUrl = `/report/${encodeURIComponent(id)}?format=pdf`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - View Report</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; background: #f1f5f9; color: #0f172a; }
  .bar { background: #0f172a; color: #fff; padding: 14px 20px; }
  .bar h1 { font-size: 16px; margin: 0; }
  .bar p { font-size: 12px; color: #94a3b8; margin: 4px 0 0; }
  .wrap { max-width: 900px; margin: 16px auto; padding: 0 16px 32px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; font-size: 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; }
  .meta div span { color: #64748b; font-size: 12px; display: block; text-transform: uppercase; letter-spacing: .04em; }
  .btn { display: inline-block; background: #4f46e5; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; font-size: 14px; }
  .btn.alt { background: #0f172a; }
  iframe { width: 100%; height: 80vh; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
  .note { font-size: 12px; color: #64748b; }
</style>
</head>
<body>
  <div class="bar">
    <h1>${esc(title)}</h1>
    <p>Genesis Nutrition &bull; Secure report link &bull; Opening this page is logged</p>
  </div>
  <div class="wrap">
    <div class="card">
      <div class="meta">
        <div><span>Scope</span><strong>${esc(scope)}</strong></div>
        <div><span>Date</span><strong>${esc(rec.date)}</strong></div>
        <div><span>File</span><strong>${esc(rec.filename)}</strong></div>
        <div><span>Sent to</span><strong>${esc((rec.recipients || []).join(', '))}</strong></div>
      </div>
      <p style="margin:12px 0 0;">
        <a class="btn" href="${esc(pdfUrl)}&amp;download=1">Download PDF</a>
        &nbsp;<span class="note">The same PDF is also attached to the email.</span>
      </p>
    </div>
    <iframe title="Report PDF" src="${esc(pdfUrl)}"></iframe>
  </div>
</body>
</html>`;
}

function notFoundHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report not found</title></head>
<body style="font-family:Arial,sans-serif;padding:40px;">
<h2>Report not found or expired</h2>
<p>This link is invalid, or the report was stored ephemerally and the server restarted. Please ask the sender to re-send the email.</p>
</body></html>`;
}
