# Oasis Weekly Marketing Assistant (n8n)

A small, simple n8n marketing assistant for **Zenith Group**, for the first
property: **Oasis Apartments** (540 Bond Street, Bridgeport, Connecticut).

## What it does, in plain English

Every Monday morning, n8n reads one Google Sheet of facts about Oasis, tries to read
the Oasis website, and uses OpenAI to do two things: (1) check the website against the
correct facts and list anything to fix, and (2) write exactly three friendly, local
social posts for the week. It then builds one short email with four sections — things
to fix, the three posts, one key recommendation, and any open questions — and emails
it to Zenith Group for review. Nothing is ever posted or changed automatically, a
person always approves. If the website can't be read, the email simply says so instead
of failing, and the assistant never guesses prices, fees, specials, availability, or
dates.

## One main workflow, three jobs

1. **Brand Check** — compares the website to the sheet and lists issues (old
   "3 months free" language, wrong company name, wrong fees, wrong lease terms,
   inconsistent messages, missing info).
2. **Weekly Content** — three posts: (1) lifestyle/outdoor, (2) apartment/floor
   plan/amenity, (3) a renter question or an available apartment. Each has an idea,
   a photo/video checklist, a caption, on-screen text, a call to action, and hashtags.
3. **Simple Weekly Report** — one email, subject **"Oasis Weekly Marketing Plan"**,
   with the four sections above.

## Files in this folder (the deliverables)

| File | What it is |
| --- | --- |
| `oasis-marketing-assistant.workflow.json` | **1.** The n8n workflow — import this into n8n |
| `google-sheet-template.csv` | **2.** The Google Sheet template (source of truth), pre-filled for Oasis |
| `SETUP-GUIDE.md` | **3.** Step-by-step setup written for a beginner |
| `CREDENTIALS.md` | **4.** The list of accounts/credentials to connect |
| `TESTING.md` | **5.** Simple testing instructions |

## The nodes (steps) in the workflow

`Start Every Monday` → `Read Oasis Information` → `Check Marketing Pages` →
`Brand Check` → `Create Three Posts` → `Build Weekly Email` → `Send to Zenith Group`

## Technology used

- One **Monday schedule trigger**
- **Google Sheets** (single source of truth)
- **OpenAI** (brand check + writing the posts)
- **Email** (Gmail node; SMTP alternative documented)
- A **simple website check** (with error handling so a bad site never stops the run)

## What it deliberately does NOT do

No database, no automatic posting, no CRM, no lead follow-up, no pricing automation,
no review responses, no ad management, and no extra workflows. One workflow, kept
small on purpose.

## Start here

Open **`SETUP-GUIDE.md`** and follow the steps.
