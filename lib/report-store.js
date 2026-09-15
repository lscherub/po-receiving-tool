// Shared report storage for "View Report" tracking.
//
// - If BLOB_READ_WRITE_TOKEN is set (a Vercel Blob store is connected to the
//   project), reports are stored durably in Blob and survive cold starts and
//   multiple instances.
// - Otherwise it falls back to in-memory storage, which works for local
//   `vercel dev` demos but is lost on restart and not shared between
//   serverless instances.
//
// Record shape:
// { id, createdAt, poNumber, vendor, date, selected, storeNames[],
//   recipients[], subject, filename, pdfBase64,
//   accesses: [{ at, ip, ua }], lastAccessedAt }

export function newReportId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    }
  } catch (_) {
    // fall through to Math.random fallback
  }
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

export function isValidReportId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function blobConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export function storageMode() {
  return blobConfigured() ? 'blob' : 'memory (ephemeral)';
}

function memMap() {
  if (!globalThis.__poReportMem) globalThis.__poReportMem = new Map();
  return globalThis.__poReportMem;
}

async function blobSdk() {
  try {
    return await import('@vercel/blob');
  } catch (_) {
    return null; // package not installed / local dev without blob
  }
}

function blobPath(id) {
  return `po-reports/${id}.json`;
}

export async function saveReport(record) {
  if (blobConfigured()) {
    const sdk = await blobSdk();
    if (sdk) {
      await sdk.put(blobPath(record.id), JSON.stringify(record), {
        access: 'public',
        contentType: 'application/json',
      });
      return;
    }
  }
  memMap().set(record.id, record);
}

export async function loadReport(id) {
  if (blobConfigured()) {
    const sdk = await blobSdk();
    if (sdk) {
      const listed = await sdk.list({ prefix: blobPath(id), limit: 5 });
      const hit =
        listed && listed.blobs && listed.blobs.find((b) => b.pathname === blobPath(id));
      if (!hit) return null;
      const r = await fetch(hit.url, { cache: 'no-store' });
      if (!r.ok) return null;
      try {
        return await r.json();
      } catch (_) {
        return null;
      }
    }
  }
  return memMap().get(id) || null;
}

export async function logReportAccess(id, entry) {
  const rec = await loadReport(id);
  if (!rec) return null;
  rec.accesses = Array.isArray(rec.accesses) ? rec.accesses : [];
  rec.accesses.push(entry);
  rec.lastAccessedAt = entry.at;
  await saveReport(rec);
  return rec;
}

export function accessEntryFromReq(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim();
  return {
    at: new Date().toISOString(),
    ip: ip || (req.socket && req.socket.remoteAddress) || '',
    ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 200),
  };
}
