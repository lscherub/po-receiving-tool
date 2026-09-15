# PO & Receiving Suite — Vercel deploy (static HTML + SMTP2GO email API)

This folder is a deployment copy of the single-page app (`index.html`, unchanged
framework — still plain HTML/JS + Tailwind CDN + html2pdf.js) plus one secure
serverless endpoint:

- `index.html` — existing app + a **Send Internal Email** button/modal on the
  export page (Step 3). Reuses `pdf-store-select`, `buildCleanPdfHtml()`,
  `renderCleanSheetIntoIframe()`, and the same html2pdf options as Export PDF.
- `api/send-email.js` — Vercel serverless function. Holds `SMTP2GO_API_KEY`
  server-side only, allowlists the 3 internal recipients, and calls
  `POST https://api.smtp2go.com/v3/email/send` with the PDF attached
  (`filename` / `fileblob` base64 / `mimetype: application/pdf`).

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

1. Push **this folder's contents** (`index.html`, `api/`, `vercel.json`,
   `package.json`) to a repo.
2. Vercel Dashboard → **Add New → Project → Import** the repo. Framework
   preset: **Other**. No build command needed.

## 3. Environment variables (Vercel Dashboard → Project → Settings → Environment Variables)

| Name              | Value example                | Env         |
| ----------------- | ---------------------------- | ----------- |
| `SMTP2GO_API_KEY` | `api-xxxxxxxxxxxxxxxx`       | Production (+ Preview) |
| `SMTP2GO_SENDER`  | `orders@genesisnutrition.ca` | Production (+ Preview) |

Redeploy after adding them.

## 4. Test

1. Open the deployed URL → Load Sample POS Data → Process & Clean → Generate Sheets.
2. Step 3 → store selector (`All Stores` / `Davie` / `Main` / `West`) →
   **Send Internal Email**.
3. Recipients auto-check to match the selector; subject/body auto-fill like
   `PO #8810 (MORPH) - Receiving Sheet - DAVIE - 2026-09-15`.
4. **Send with PDF** → success toast + modal status. Check inbox +
   SMTP2GO Dashboard → Activity.

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
