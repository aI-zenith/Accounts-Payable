# Simple Testing Instructions

You do **not** have to wait until Monday to test. You can run the workflow by hand.

## Test 1 — Run it once, end to end

1. Open the workflow in n8n.
2. Click the big **Execute Workflow** button (bottom center).
3. Watch the nodes turn green one by one, left to right.
4. Check your inbox for an email titled **"Oasis Weekly Marketing Plan"**.

**You should see an email with four sections:**
1. Things Zenith Group Should Fix
2. This Week's Three Social Posts (exactly three)
3. One Most Important Recommendation
4. Questions That Need an Answer

If all four are there, it works. 🎉

## Test 2 — Check each step on its own

Click any node, then click **Execute step**, to see just that node's result:

- **Read Oasis Information** → should show the Oasis row from your sheet.
  (If it's empty, check the Sheet ID and that the tab is named `Properties`.)
- **Check Marketing Pages** → should show website text (a big blob of text).
- **Brand Check** → should show an `issues` list.
- **Create Three Posts** → should show three `posts`.
- **Build Weekly Email** → should show `subject`, `to`, `html`, and `text`.

## Test 3 — Make sure a broken website doesn't stop it

This proves the basic error handling works.

1. Click **Read Oasis Information** → temporarily change the sheet's **Website** cell
   to a bad address like `https://this-site-does-not-exist-123.com` (or edit the URL
   in the node for a quick test).
2. Run **Execute Workflow** again.
3. The workflow should still finish and send the email. Under **Things Zenith Group
   Should Fix** you should see:
   *"Website could not be checked automatically this week — please review it by hand."*
4. Put the correct website back afterward.

## Test 4 — Check the "no guessing" rule

1. Temporarily **clear** a fact cell that a post might need — for example, empty the
   **Current special** cell (put it back afterward).
2. Run the workflow.
3. The email's **Questions That Need an Answer** section should include a
   *"Need your answer: ..."* line instead of a made-up value. It should never invent a
   special, price, fee, or date.

## What to check in the writing

- The three posts sound **friendly and local**, not like an ad.
- None of these banned phrases appear: "luxury living at its finest",
  "your dream home awaits", "act now before it is gone".
- No invented **prices, availability, fees, specials, or dates**.

## If something goes wrong

- Open n8n → **Executions** to see the last runs and any error messages.
- A red node shows which step failed. Most common causes:
  - Google Sheet ID wrong, or tab not named `Properties`.
  - OpenAI credential missing or out of quota.
  - Gmail not signed in.
- Fix the cause, then click **Execute Workflow** again.
