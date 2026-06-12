# Invoice Bridge

A small, production-ready web app for accounts-payable staff. Upload a vendor
invoice (PDF), let Claude vision extract the data, review and correct it, then
(later) push the record to Rent Manager and attach the original PDF.

- **Stack:** Node 20+ / Express, EJS server-rendered views, PostgreSQL (Neon),
  the Claude API for extraction. ES modules throughout. Deployable on Render.

## How it works

1. **Upload** — drop a PDF on the dashboard. A row is created (`pending`) and
   extraction is kicked off in the background (`extracting`).
2. **Extract** — `claude-opus-4-8` reads the PDF and returns strict JSON
   (vendor, invoice #, dates, line items, totals, etc.). Stored on the row and
   copied into flat columns (`extracted`).
3. **Review** — a two-column screen: the PDF on the left, an editable form on
   the right. Correct anything and **Save changes** (`confirmed`).
4. **Push** — **Push to Rent Manager** will create the record and attach the
   PDF. This is **stubbed** today — see below.

## Rent Manager push is stubbed (pending API discovery)

`src/services/rmClient.js` implements authentication and a generic
`request()` helper, but `createProject()` and `attachDocument()` are
deliberately left as clearly-marked **stubs** that throw
`TODO: wire endpoint after discovery`. The exact WAPI12 resource paths and
payload shapes need to be confirmed against a live account first.

Use the one-off `discover.js` at the repo root to probe your account's
endpoints (authenticates, then prints the JSON shape + first record for the
candidate endpoints, plus the rate-limit headers). Once you know the real
endpoints, wire them into the two stub functions. The push button already
catches the stub error and shows a friendly "not wired yet" message, so the
rest of the flow is usable today.

## Local setup

```bash
npm install

# 1. Create your env file and fill it in
cp .env.example .env

# 2. Generate an encryption key for at-rest secret storage
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#    paste the result into APP_ENCRYPTION_KEY in .env

# 3. Point DATABASE_URL at your Neon database (must include sslmode=require)

# 4. Create the tables
npm run migrate

# 5. Run it
npm start          # or: npm run dev   (auto-reload via node --watch)
```

Then open http://localhost:3000.

### Secrets: Settings UI or environment

Credentials can be entered two ways and resolve in this order per field:

1. The value saved in **Settings** (encrypted at rest with AES-256-GCM), else
2. the matching `.env` fallback (`ANTHROPIC_API_KEY`, `RM_SUBDOMAIN`,
   `RM_USERNAME`, `RM_PASSWORD`).

`src/services/credentials.js` is the single resolver both `extract.js` and
`rmClient.js` use, so the app behaves identically either way. Stored secrets
are shown **masked** (last 4 chars) and never logged in plaintext. Leaving a
secret field blank on save keeps the existing value.

Each integration has a **Test connection** button (Rent Manager auth; a cheap
1-token Claude ping) with a status dot: grey = untested, green = connected,
red = failed.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (include `sslmode=require`) |
| `APP_ENCRYPTION_KEY` | base64 of 32 random bytes; encrypts stored secrets |
| `ANTHROPIC_API_KEY` | fallback Claude key if not set in Settings |
| `RM_SUBDOMAIN` / `RM_USERNAME` / `RM_PASSWORD` | fallback Rent Manager creds |
| `PORT` | default `3000` |
| `NODE_ENV` | `development` / `production` |
| `UPLOAD_DIR` | where PDFs are stored (default `./uploads`) |

## Deploy: GitHub → Render

`render.yaml` is a Render blueprint defining one web service:

- **Build:** `npm install && npm run migrate`
- **Start:** `npm start`
- **Node:** 20
- A **persistent disk** mounted at `/uploads` so uploaded PDFs survive deploys
  (set `UPLOAD_DIR=/uploads`, which the blueprint does).
- All secrets are declared with `sync: false`, so they are **set in the Render
  dashboard**, not committed to the repo.

Steps:

1. Push this repo to GitHub.
2. In Render, **New → Blueprint** and point it at the repo; it reads
   `render.yaml`.
3. Fill in the `sync: false` env vars (`DATABASE_URL`, `APP_ENCRYPTION_KEY`,
   `ANTHROPIC_API_KEY`, and the `RM_*` fallbacks) in the dashboard.
4. Deploy. The build runs the migration; the service starts on the assigned
   port. A health check is exposed at `/healthz`.

## Project structure

```
src/
  server.js              Express app, static, EJS, route mounting
  db/pool.js             pg Pool (DATABASE_URL, ssl)
  db/migrate.js          create tables if not exists
  services/crypto.js     AES-256-GCM encrypt/decrypt + mask
  services/credentials.js getCredentials() resolver (DB -> .env)
  services/extract.js    Claude API: PDF -> structured JSON
  services/rmClient.js   Rent Manager client: auth + STUBS
  routes/invoices.js     dashboard, upload, review, confirm, push, file, delete
  routes/settings.js     settings + connection tests
views/                   EJS: layout, dashboard, review, settings, error
public/css/styles.css    the design
public/js/app.js         drag-drop upload, line-item editing, connection tests
uploads/                 stored PDFs (gitignored)
discover.js              one-off Rent Manager API discovery script
```
