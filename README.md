# Invoice Bridge

A small, production-ready web app for accounts-payable staff. Bills arrive two
ways — **emailed to a dedicated inbox** or **uploaded by hand** — and each one is
read by Claude, mapped to the right records, and posted to Rent Manager as a
**credit card transaction**.

- **Stack:** Node 20+ / Express, EJS server-rendered views, PostgreSQL (Neon),
  the Claude API for extraction, IMAP for email intake. ES modules throughout.
  Deployable on Render.

## How it works

There are two entry points that converge on the same extract → match → push
pipeline:

- **Email (hands-off)** — the app polls a dedicated IMAP mailbox. Every new
  message with a PDF attachment becomes an invoice row (`source = email`), is
  extracted, and — when **Auto-push** is on — is posted to Rent Manager
  automatically. Anything that can't be matched confidently is flagged
  `needs_review` instead of guessed. Configure the mailbox in **Settings → Email
  inbox**.
- **Upload (manual)** — drop a PDF on the dashboard for the same flow with a
  review step.

1. **Ingest** — a row is created (`pending`) and extraction kicks off
   (`extracting`).
2. **Extract** — `claude-opus-4-8` reads the PDF and returns strict JSON
   (vendor, invoice #, dates, line items, totals, **credit card**, property/job
   reference, etc.). Stored on the row (`extracted`).
3. **Match & push** — resolve the credit card, vendor (auto-created if new), and
   property, then create the credit card transaction (`pushed`). Emailed bills do
   this automatically; uploaded bills do it on **Push to Rent Manager** after an
   optional **Review** step.

### How a bill is assigned to a property

The property is **identified by the credit card** used on the bill — each card in
Rent Manager belongs to a property, and that's the source of truth. The invoice's
job/property reference is then used as a **second-step verification**: it must
match that property (by name) or one of its **units**. If the card isn't linked
to a property, or the job name doesn't match the card's property or a unit, the
bill is flagged `needs_review` rather than posted to the wrong place.

## Rent Manager integration

`src/services/rmClient.js` implements the live API integration for the `bluegm`
account:

- **Base URL** `RENTMANAGER_BASE_URL` (e.g. `https://bluegm.api.rentmanager.com`).
- **Auth** `POST /authentication/AuthenticateUser` with
  `{ Username, Password, LocationID }`. The token (a JSON-quoted string) is
  cached in module scope, warmed once on server startup, and proactively
  refreshed after a TTL.
- **Every request** carries the `X-RM12API: <token>` header via the generic
  `request()` helper, which also returns the response headers (for the
  `Location` of created records) and logs rate-limit headers.
- **401 handling** — a `401` triggers a single re-authenticate-and-retry.

Credentials come from `RENTMANAGER_USERNAME` / `RENTMANAGER_PASSWORD` (and
`RENTMANAGER_LOCATION_ID`, default `1`), or from the encrypted values in
**Settings**.

The **push** is wired: `pushInvoiceToRentManager()` (`src/services/pushInvoice.js`)
resolves the credit card, vendor, and property, then `POST`s a
`CreditCardTransaction`. Record resolution lives in `rmClient.js`:

- `findCreditCardByName` / `findVendorByName` (+ `createVendor`) — fuzzy name match.
- `findPropertyForCreditCard` — the card → property link (tries `PropertyID` on
  the card, an embedded `Property`, a `?embeds=Property` re-fetch, then a name
  fallback). The exact field your account uses may differ — `discover.js` and the
  temporary `/settings/rm-discovery` route can confirm it.
- `jobMatchesPropertyOrUnit` — the second-step check against the property's
  units (`/Units?filter=PropertyID,eq,…`, falling back to `?embeds=Units`).

After the transaction is created, the original PDF is attached via
`attachReceipt`. Attachments don't live on the WAPI host — they go through the
RM web app (`rmx`) host, which uses an **ASP.NET session** (not the WAPI token):
the client logs in (`POST /api/ExpressAuthentication/Authenticate` with the RM
credentials) to get an `ASP.NET_SessionId` cookie, then POSTs the receipt as
`multipart/form-data` to `/api/CreditCardTransactions/{id}/Attachments` (a
`dataModel` JSON string `{ EntityKeyID, EntityType: 38, Description }` plus the
file part). The session is cached and re-established on expiry/401. The attach is
best-effort and non-fatal: the transaction already exists, so a failed attach is
surfaced as a note rather than re-pushed (which would double-charge). The new
attachment id is saved to `rm_attachment_id`, and an already-pushed invoice is
never re-created — it only (re)attaches if the receipt is missing.

The property/expense **allocation** rides on the transaction's required
`CreditCardTransactionDetails` (PropertyID + GLAccountID + Amount), so each push
posts a fully-allocated charge.

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
| `RENTMANAGER_BASE_URL` | Rent Manager API base, e.g. `https://bluegm.api.rentmanager.com` |
| `RENTMANAGER_USERNAME` / `RENTMANAGER_PASSWORD` | Rent Manager credentials |
| `RENTMANAGER_LOCATION_ID` | location id for auth (default `1`) |
| `RM_SUBDOMAIN` / `RM_USERNAME` / `RM_PASSWORD` | legacy fallbacks |
| `IMAP_HOST` / `IMAP_PORT` | inbox to poll for emailed bills (e.g. `imap.gmail.com` / `993`) |
| `IMAP_USER` / `IMAP_PASSWORD` | mailbox login (use an **app password**) |
| `IMAP_MAILBOX` | folder to watch (default `INBOX`) |
| `IMAP_ALLOWED_SENDERS` | optional comma-separated sender allow-list |
| `EMAIL_AUTO_PUSH` | `true` (auto-post) / `false` (hold for review). Default `true` |
| `EMAIL_POLL_INTERVAL_MS` | poll cadence (default `60000`) |
| `PORT` | default `3000` |
| `NODE_ENV` | `development` / `production` |

All `IMAP_*` / `EMAIL_*` values can also be set in **Settings → Email inbox**
(the password is encrypted at rest there), and resolve DB-first like the other
secrets. Leave the inbox unconfigured to disable email intake entirely.

Uploaded PDFs are stored in Postgres (the `invoices.file_data` column), so they
survive deploys and restarts — no persistent disk or `UPLOAD_DIR` is required.

## Deploy: GitHub → Render

`render.yaml` is a Render blueprint defining one web service:

- **Build:** `npm install && npm run migrate`
- **Start:** `npm start`
- **Node:** 20
- No persistent disk required — PDFs are stored in Postgres.
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
  services/credentials.js getCredentials() resolver (DB -> .env), incl. inbox
  services/extract.js    Claude API: PDF -> structured JSON
  services/ingest.js     shared extract-and-store (upload + email)
  services/pushInvoice.js card/vendor/property matching + create transaction
  services/emailPoller.js IMAP poll -> ingest -> auto-push
  services/rmClient.js   Rent Manager client: auth + lookups + create
  routes/invoices.js     dashboard, upload, review, confirm, push, file, delete
  routes/settings.js     settings + connection tests (RM / Claude / email)
views/                   EJS: layout, dashboard, review, settings, error
public/css/styles.css    the design
public/js/app.js         drag-drop upload, line-item editing, connection tests
uploads/                 stored PDFs (gitignored)
discover.js              one-off Rent Manager API discovery script
```
