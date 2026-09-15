# PO & Receiving Suite — Vercel deploy (static HTML + SMTP2GO email API + tracked report links)

This folder is a deployment copy of the single-page app (`index.html`, unchanged
framework — still plain HTML/JS + Tailwind CDN + html2pdf.js) plus secure
serverless endpoints:

- `index.html` — existing app + a **Send Internal Email** button/modal on the
  export page (Step 3). Reuses `pdf-store-select`, `buildCleanPdfHtml()`,
  `renderCleanSheetIntoIframe()`, and the same html2pdf options as Export PDF.
  Now also mints a per-send `reportId` and posts the same PDF bytes +
  store scope for tracking.
- `api/send-email.js` — holds `SMTP2GO_API_KEY` server-side only, allowlists
  the 3 internal recipients, stores the PDF under the report ID, appends a
  **View Report** button (`/report/<id>`) to the email, and still attaches
  the PDF (`filename` / `fileblob` base64 / `mimetype: application/pdf`).
- `api/report/[id].js` (+ `vercel.json` rewrite `/report/:id` → this) —
  logs `{at, ip, ua}` on each view, then shows the correct PDF (scope-aware,
  incl. All Stores) with a Download button. `?format=pdf` serves raw bytes.
- `api/report-status.js` — `GET /api/report-status?id=<id>` returns
  `accessCount / firstAccessedAt / lastAccessedAt / accesses[]`.
- `lib/report-store.js` — storage layer. Durable **Vercel Blob** when
  `BLOB_READ_WRITE_TOKEN` is present, else ephemeral in-memory (dev only).

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
3. **Recommended for tracking:** Vercel Dashboard → **Storage → Create →
   Blob**, then **Connect** it to this project (auto-adds
   `BLOB_READ_WRITE_TOKEN`). Without it, `/report/<id>` still works but
   access logs are lost on cold starts/restarts.

## 3. Environment variables (Vercel Dashboard → Project → Settings → Environment Variables)

| Name              | Value example                | Env         |
| ----------------- | ---------------------------- | ----------- |
| `SMTP2GO_API_KEY` | `api-xxxxxxxxxxxxxxxx`       | Production (+ Preview) |
| `SMTP2GO_SENDER`  | `orders@genesisnutrition.ca` | Production (+ Preview) |
| `BLOB_READ_WRITE_TOKEN` | *(auto-added when Blob store connected)* | Production (+ Preview) |

Redeploy after adding them.

## 4. Test

1. Open the deployed URL → Load Sample POS Data → Process & Clean → Generate Sheets.
2. Step 3 → store selector (`All Stores` / `Davie` / `Main` / `West`) →
   **Send Internal Email**.
3. Recipients auto-check to match the selector; subject/body auto-fill like
   `PO #8810 (MORPH) - Receiving Sheet - DAVIE - 2026-09-15`.
4. **Send with PDF + Tracked Link** → success toast + modal status + tracked-link
   box with a **Check views** button. Check inbox: email has the PDF attachment
   AND a **View Report** button.
5. Click **View Report** → viewer page shows the right store scope (try DAVIE vs
   All Stores) with inline PDF + Download. Each open appends
   `{at, ip, ua}` server-side.
6. Check access: modal **Check views**, or
   `GET https://<your-app>.vercel.app/api/report-status?id=<reportId>` → JSON
   with `accessCount / firstAccessedAt / lastAccessedAt / accesses[]`.

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
