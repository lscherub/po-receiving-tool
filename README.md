# PO & Receiving Suite — Vercel deploy (static HTML + SMTP2GO email API + tracked report links)

This folder is a deployment copy of the single-page app (`index.html` —
plain HTML/JS + Tailwind CDN + html2pdf.js) plus secure serverless endpoints:

- `index.html` — existing app + a **Send Internal Email** button/modal on the
  export page (Step 3). Reuses `pdf-store-select`, `buildCleanPdfHtml()`,
  `renderCleanSheetIntoIframe()`, and the same html2pdf options as Export PDF.
  Now also mints a per-send `reportId` and posts the same PDF bytes +
  store scope for tracking. Header also has a head-office **Reports** link
  to `/report/` (no change to email/PDF/print/upload flows).
- `api/send-email.js` — holds `SMTP2GO_API_KEY` server-side only, allowlists
  the 3 internal recipients, stores the PDF under the report ID, appends a
  **View Report** button (`/view/<id>`) to the email, and still attaches
  the PDF (`filename` / `fileblob` base64 / `mimetype: application/pdf`).
- `api/view/[id].js` (+ `vercel.json` rewrite `/view/:id` → this) —
  logs `{at, ip, ua}` on each view, then shows the correct PDF (scope-aware,
  incl. All Stores) with a Download button. No Reports link on this page.
- `api/report-status.js` — `GET /api/report-status?id=<id>` returns
  `accessCount / firstAccessedAt / lastAccessedAt / accesses[]`.
- `api/reports.js` — `GET /api/reports` (header `x-report-password`) returns
  the newest-first head-office history from Blob metadata summaries.
- `lib/report-store.js` — storage layer: durable **Vercel Blob** only
  (`po-reports/<id>.pdf` + `po-reports/<id>.json`, no in-memory fallback).

## 1. SMTP2GO setup (5 min)

1. Create/login at https://www.smtp2go.com → **Settings → API Keys** → create key.
2. **Settings → Verified Senders** → verify the address you will send FROM
   (e.g. `orders@genesisnutrition.ca`). SMTP2GO rejects unverified senders.
3. Note the key value (`api-XXXX...`). You will paste it into Vercel, never into code.

## 2. Deploy on Vercel

Option A — drag & drop / CLI from this folder:

```bash
cd po-receiving-vercel
npx vercel          # first run: link/create project
npx vercel --prod   # deploy production
```

Option B — GitHub:

1. Push **this folder's contents** (`index.html`, `api/`, `lib/`, `vercel.json`,
   `package.json`) to a repo.
2. Vercel Dashboard → **Add New → Project → Import** the repo. Framework
   preset: **Other**. No build command needed. (`npm install` picks up
   `@vercel/blob` for report storage.)
3. **REQUIRED for tracked links:** Vercel Dashboard → **Storage → Create →
   Blob**, then **Connect** it to this project (auto-adds
   `BLOB_READ_WRITE_TOKEN`), then **redeploy**. Email sending is blocked
   without it, so you can never get an attachment without a working link.
   Old `/report/<id>` links from the previous build are obsolete — send a new
   email to get a `/view/<id>` link.

## 3. Environment variables (Vercel Dashboard → Project → Settings → Environment Variables)

| Name              | Value example                | Env         |
| ----------------- | ---------------------------- | ----------- |
| `SMTP2GO_API_KEY` | `api-xxxxxxxxxxxxxxxx`       | Production (+ Preview) |
| `SMTP2GO_SENDER`  | `orders@genesisnutrition.ca` | Production (+ Preview) |
| `BLOB_READ_WRITE_TOKEN` | *(auto-added when Blob store connected)* | Production (+ Preview) |
| `REPORT_PASSWORD` | *(any shared head-office password, e.g. `genesis-reports-2026`)* | Production (+ Preview) |

Redeploy after adding them.

### Report history page (`/report/`)

- Main-app header has a **Reports** link → `/report/` (head-office only).
- `/report/` is a static page asking for the shared `REPORT_PASSWORD`,
  then calls `GET /api/reports` with header `x-report-password`.
- The API compares against `process.env.REPORT_PASSWORD` server-side only
  (timing-safe); the password is never baked into frontend code.
- Table columns: sent time, store/scope, sent-to, PO/details, viewed
  (`Waiting...` until first `/view/<id>` open, then first-open time),
  and the report/PDF link. Kept newest-first.
- Recipient-facing `/view/<id>` pages have NO Reports button/link.

## 4. Test

1. Open the deployed URL → Load Sample POS Data → Process & Clean → Generate Sheets.
2. Step 3 → store selector (`All Stores` / `Davie` / `Main` / `West`) →
   **Send Internal Email**.
3. Recipients auto-check to match the selector; subject/body auto-fill like
   `PO #8810 (MORPH) - Receiving Sheet - DAVIE - 2026-09-15`.
4. **Send with PDF + Tracked Link** → success toast + modal status + tracked-link
   box with a **Check views** button. Check inbox: email has the PDF attachment
   AND a **View / Download PDF Report** button + plain URL.
5. Click the link (`https://<your-app>.vercel.app/view/<id>`) → viewer page
   shows the right store scope (try DAVIE vs All Stores) with the PDF loaded
   from Blob + Download. Each open appends `{at, ip, ua}` to Blob metadata.
6. Check access: open `/report/` (password = `REPORT_PASSWORD`) for the
   history table, or modal **Check views**, or
   `GET https://<your-app>.vercel.app/api/report-status?id=<reportId>` → JSON
   with `reportType/selected/storeNames/recipients/sent date/viewed/
   accessCount/firstAccessedAt/lastAccessedAt/accesses[]`.
7. Cleanup: `vercel.json` schedules `GET /api/cron-cleanup` daily 03:00 UTC,
   which deletes `po-reports/<id>.pdf` + `po-reports/<id>.json` pairs whose
   metadata `createdAt` is older than 14 days (fallback: Blob `uploadedAt`). Set `CRON_SECRET`
   (any random string) so manual hits require
   `Authorization: Bearer <secret>`; Vercel Cron sends it automatically.
   Note: Hobby plan runs crons once daily max — the schedule above complies.

## 5. Local test (optional)

```bash
SMTP2GO_API_KEY=api-xxx SMTP2GO_SENDER=orders@genesisnutrition.ca npx vercel dev
# then open http://localhost:3000
```

## Security notes

- The API key exists **only** in `process.env` on the server (`api/send-email.js`).
  The browser only sends `to/subject/textBody/htmlBody/filename/fileblob` to
  `/api/send-email`. Never commit `.env` (see `.gitignore`).
- The endpoint only sends to
  `davie@genesisnutrition.ca`, `main@genesisnutrition.ca`,
  `west@genesisnutrition.ca` — anything else returns 400. This stops open-relay abuse.
- Attachments capped at ~15 MB base64 (SMTP2GO max is 50 MB total).

## GitHub Pages note

GitHub Pages serves static files only, so `/api/send-email` will 404 there.
Keep GitHub Pages for the plain app if you like, but the email button needs the
Vercel deployment above.
