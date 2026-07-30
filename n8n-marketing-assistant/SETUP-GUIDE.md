# Oasis Weekly Marketing Assistant — Beginner Setup Guide

This is a small n8n workflow. It runs **once every Monday morning** and emails
Zenith Group **one short plan** for Oasis Apartments: things to fix, three social
posts, one recommendation, and any questions that need an answer.

**Nothing is posted or changed automatically.** A person always reviews the email
and decides what to do.

You only need to set this up **one time**. After that it runs on its own.

---

## What you need before you start

1. An **n8n account** (n8n Cloud is the easiest — go to n8n.io) or a self-hosted n8n.
2. A **Google account** (for the Google Sheet and for sending the Gmail email).
3. An **OpenAI account** with an API key (from platform.openai.com).

That's it. Set aside about 30 minutes.

---

## Step 1 — Create the Google Sheet (the "source of truth")

The workflow reads all its facts from **one Google Sheet**. This is the only place
you keep information, so it's the only place you ever have to update.

1. Go to Google Sheets and create a **new, blank spreadsheet**.
2. Name the spreadsheet: **Oasis Marketing Source of Truth**.
3. Rename the bottom tab from `Sheet1` to **`Properties`** (double-click the tab name).
4. Open the file **`google-sheet-template.csv`** included here, and copy its contents
   into the sheet. The easiest way:
   - In Google Sheets: **File → Import → Upload**, choose `google-sheet-template.csv`,
     and pick **"Replace current sheet"**. Make sure the tab is still named `Properties`.
5. Your sheet now has these columns (row 1 is the headers, row 2 is Oasis):

   | Column | Example |
   | --- | --- |
   | Property name | Oasis Apartments |
   | Management company | Zenith Group |
   | Website | https://www.oasisaptsct.com |
   | Address | 540 Bond Street, Bridgeport, Connecticut |
   | Lease term | 13 months |
   | Current special | 1 month free |
   | Amenity fee | $150 |
   | Wi-Fi fee | $75 |
   | Brand message | Modern apartments in a peaceful private community |
   | Tagline | Find Your Space. Find Your Peace. |
   | Contact phone | (fill this in) |
   | Contact email | ai@zenithgroupmgmt.com |
   | Approved notes | social links, listing notes, "don't guess" reminder |

> **Important:** Keep the column names **exactly** as they are. The workflow looks
> them up by name. If you rename a column, the workflow won't find it.

6. **Copy the Sheet ID.** Look at the sheet's web address:
   `https://docs.google.com/spreadsheets/d/`**`THIS_LONG_PART_IS_THE_ID`**`/edit`
   Copy that long middle part — you'll paste it into n8n in Step 3.

---

## Step 2 — Import the workflow into n8n

1. In n8n, click **Workflows → Import from File** (or the **"..." menu → Import**).
2. Choose the file **`oasis-marketing-assistant.workflow.json`** included here.
3. You'll see 7 boxes ("nodes") connected left to right:
   **Start Every Monday → Read Oasis Information → Check Marketing Pages →
   Brand Check → Create Three Posts → Build Weekly Email → Send to Zenith Group.**

Some nodes will show a small warning that a credential is missing — that's expected.
We connect them next.

---

## Step 3 — Connect your accounts (credentials)

You connect three accounts. In n8n, "credentials" just means "log in once so the
workflow can use this account." Full details are in **`CREDENTIALS.md`**.

### 3a. Google Sheets
1. Click the **Read Oasis Information** node.
2. Under **Credential to connect with**, click **Create New** and choose
   **Google Sheets OAuth2**. Follow the sign-in popup with your Google account.
3. In the same node, find **Document** → choose **By ID** and paste the **Sheet ID**
   from Step 1. (Or pick it from the list if it shows up.)
4. Set **Sheet** to **`Properties`**.

### 3b. OpenAI
1. Click the **Brand Check** node.
2. Under **Credential**, click **Create New**, choose **OpenAI**, and paste your
   **OpenAI API key**.
3. Click the **Create Three Posts** node and select the **same** OpenAI credential
   from the dropdown (no need to create it twice).

### 3c. Gmail (to send the email)
1. Click the **Send to Zenith Group** node.
2. Under **Credential**, click **Create New**, choose **Gmail OAuth2**, and sign in
   with the Google account that should send the email.
3. The email goes **to the address in the sheet's "Contact email" column**
   (currently `ai@zenithgroupmgmt.com`). To change who receives it, just change that
   cell in the sheet — no need to edit the workflow.

> Prefer regular email instead of Gmail? See the note at the bottom of
> **`CREDENTIALS.md`** for using the plain "Send Email" (SMTP) node instead.

---

## Step 4 — Fill in what's missing

Open the sheet and replace any cell that says **`Need your answer: ...`** with the
real value (for example, the contact phone number). The workflow never guesses these
— if you leave them blank, the Monday email will politely ask for them.

---

## Step 5 — Turn it on

1. Test it first (see **`TESTING.md`**).
2. When you're happy, toggle the workflow to **Active** (top-right switch in n8n).
3. Done. Every Monday at 8:00 AM you'll get the **"Oasis Weekly Marketing Plan"** email.

To change the day or time, open **Start Every Monday** and adjust the schedule.

---

## How to maintain it (the easy part)

- **To update facts** (new special, new fee, new tagline): edit the **Google Sheet**.
  You never need to touch the workflow.
- **To add another property later:** add a new row to the sheet. (This starter
  version emails about the first row; ask for help if you want it to loop through
  several properties.)
- **If a Monday email doesn't arrive:** open n8n → **Executions** to see what happened.
  The workflow is built so a broken website won't stop it — it will just say the site
  couldn't be checked.
