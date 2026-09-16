// Serves /view/<id>: logs access in Blob metadata, then renders a viewer
// page that loads the PDF from Blob. ?download=1 logs + redirects to Blob.
import { isValidReportId, getReportMeta, logReportAccess, accessEntryFromReq } from '../../lib/report-store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed. Use GET.');
  const id = req.query && req.query.id;
  if (!isValidReportId(id)) return res.status(400).send('Invalid report id.');
  const meta = await getReportMeta(id);
  if (!meta || !meta.pdfUrl) {
    return res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8').send(notFoundHtml());
  }
  try { await logReportAccess(id, accessEntryFromReq(req)); } catch (e) { console.error('view log failed:', e); }
  if (String(req.query.download || '') === '1') {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, meta.pdfUrl);
  }
  return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').setHeader('Cache-Control', 'no-store').send(viewerHtml(meta, id));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function viewerHtml(m, id) {
  const title = 'PO #' + (m.poNumber || '?') + ' (' + (m.vendor || '?') + ') - Receiving Sheet';
  const scope = m.selected === 'ALL' ? 'All Stores' + (m.storeNames && m.storeNames.length ? ' (' + m.storeNames.join(', ') + ')' : '') : (m.selected || '');
  const pdfUrl = m.pdfUrl;
  const dl = '/view/' + encodeURIComponent(id) + '?download=1';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + esc(title) + ' - View Report</title>'
    + '<style>body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f1f5f9;color:#0f172a}'
    + '.bar{background:#0f172a;color:#fff;padding:14px 20px}.bar h1{font-size:16px;margin:0}'
    + '.bar p{font-size:12px;color:#94a3b8;margin:4px 0 0}'
    + '.wrap{max-width:900px;margin:16px auto;padding:0 16px 32px}'
    + '.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:16px;font-size:14px}'
    + '.meta{display:flex;flex-wrap:wrap;gap:8px 24px}.meta div span{color:#64748b;font-size:12px;display:block;text-transform:uppercase}'
    + '.btn{display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px}'
    + 'iframe{width:100%;height:80vh;border:1px solid #e2e8f0;border-radius:12px;background:#fff}'
    + '.note{font-size:12px;color:#64748b}</style></head><body>'
    + '<div class="bar"><h1>' + esc(title) + '</h1><p>Genesis Nutrition &bull; Secure report link &bull; Opening this page is logged</p></div>'
    + '<div class="wrap"><div class="card"><div class="meta">'
    + '<div><span>Scope</span><strong>' + esc(scope) + '</strong></div>'
    + '<div><span>Date</span><strong>' + esc(m.date) + '</strong></div>'
    + '<div><span>File</span><strong>' + esc(m.filename) + '</strong></div>'
    + '<div><span>Sent to</span><strong>' + esc((m.recipients || []).join(', ')) + '</strong></div>'
    + '</div><p style="margin:12px 0 0;"><a class="btn" href="' + esc(dl) + '">Download PDF</a>'
    + ' &nbsp;<a class="btn" style="background:#0f172a" href="' + esc(pdfUrl) + '">Open PDF directly</a>'
    + ' &nbsp;<span class="note">Use the Download button to save the PDF.</span></p></div>'
    + '<iframe title="Report PDF" src="' + esc(pdfUrl) + '"></iframe></div></body></html>';
}

function notFoundHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report not found</title></head>'
    + '<body style="font-family:Arial,sans-serif;padding:40px;"><h2>Report not found or expired</h2>'
    + '<p>This link is invalid or the report was deleted after 14 days. Please ask the sender to re-send the email.</p></body></html>';
}
