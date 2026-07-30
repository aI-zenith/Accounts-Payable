# Credentials That Must Be Connected

The workflow needs **three** accounts connected in n8n. Each one is connected only
once, inside n8n's **Credentials** area (or by clicking the node and choosing
"Create New").

| # | Credential (n8n type) | Used by node(s) | What you need | How to get it |
| - | --- | --- | --- | --- |
| 1 | **Google Sheets OAuth2** | Read Oasis Information | A Google account that can open the sheet | In the node, click **Create New → Google Sheets OAuth2** and sign in |
| 2 | **OpenAI** | Brand Check, Create Three Posts | An OpenAI **API key** | platform.openai.com → **API keys → Create new secret key** |
| 3 | **Gmail OAuth2** | Send to Zenith Group | The Google account that will **send** the email | In the node, click **Create New → Gmail OAuth2** and sign in |

Notes:

- **OpenAI is shared:** create the OpenAI credential once, then select it in **both**
  the Brand Check and Create Three Posts nodes.
- **No passwords are stored in the files here.** All keys and logins live only inside
  n8n's encrypted credential store. The workflow JSON only contains placeholders like
  `REPLACE_WITH_OPENAI_CREDENTIAL`.
- **Model used:** `gpt-4o-mini` (inexpensive and good enough for this). You can change
  the model in the two OpenAI nodes if you like.

## Optional: use plain email (SMTP) instead of Gmail

If you don't want to use Gmail, delete the **Send to Zenith Group** node and add a
**Send Email** node in its place:

1. Add node → **Send Email** (`n8n-nodes-base.emailSend`).
2. Create an **SMTP** credential (host, port, user, password from your email provider).
3. Set the fields:
   - **To:** `={{ $json.to }}`
   - **Subject:** `={{ $json.subject }}`
   - **HTML:** `={{ $json.html }}`
   - **Text:** `={{ $json.text }}`
4. Connect **Build Weekly Email → Send Email**.

Everything else stays the same.
