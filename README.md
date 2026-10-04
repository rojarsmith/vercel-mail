# vercel-mail

**English** | [繁體中文](README.zh-TW.md)

A RESTful API deployed on [Vercel](https://vercel.com/) that sends email through the **Gmail API** using Google OAuth2 (refresh token).
Supports plain text, HTML, inline images (CID / data URI), attachments, multiple recipients, CC/BCC, Reply-To, custom headers and more.

## Technical Feasibility

Conclusion: **Feasible**.

| Item | Assessment |
| --- | --- |
| Runtime | Vercel Serverless Function (Node.js ≥ 20 with built-in `fetch`); no framework, no build step |
| Authentication | Exchanges the OAuth2 refresh token at `oauth2.googleapis.com/token` for an access token (valid 1 hour, cached while the function is warm); no `googleapis` package needed |
| Message composition | **Nodemailer** builds standard MIME: plain text, HTML, attachments, inline images (CID / data URI), non-ASCII subjects and filenames, CC/BCC, etc. |
| Delivery | **Gmail API (HTTPS)** `users.messages.send`, uploading the raw message as `message/rfc822`; SMTP is not used |
| Why not SMTP | SMTP connections are more prone to timeouts or blocking in serverless environments; HTTPS is more reliable, and the Gmail API accepts messages up to 35 MB |
| Main limitation | Vercel request body limit is 4.5 MB → base64 attachments embedded in JSON total about 3 MB; use `href` URL attachments for larger files |
| Verified | MIME composition (multiple recipients, CJK text, inline images, attachments, BCC preserved), input validation, API key auth and error handling were tested locally; real delivery must be verified via `/api/health` and `/api/send` after configuring Vercel environment variables |

## Architecture

```
Client ──POST /api/send (Bearer API_KEY, JSON)──▶ Vercel Function
                                                  │ 1. Nodemailer builds MIME (HTML/attachments/inline images)
                                                  │ 2. Refresh token → access token (cached while warm)
                                                  ▼ 3. POST gmail.googleapis.com …/messages/send (message/rfc822)
                                               Gmail
```

## Files

| Path | Description |
| --- | --- |
| `api/send.js` | `POST /api/send` sends email |
| `api/health.js` | `GET /api/health` checks env vars and whether the refresh token still works (sends nothing) |
| `lib/mailer.js` | Validation, OAuth token, MIME composition, Gmail API calls |
| `.env.example` | Environment variable template (for local `vercel dev`) |

---

## 1. Google Setup (required checks)

1. **Set the OAuth consent screen publishing status to "In production"**
   If your token response shows `refresh_token_expires_in: 604799` (about 7 days), the app is still in **Testing**
   and the refresh token will expire after 7 days. Go to Google Cloud Console → *Google Auth Platform* → *Audience* →
   **Publish app**. For personal use no verification review is required; sign-in will show an "unverified app" warning — click "Continue".
   **Obtain a new refresh token after publishing** (tokens issued before still expire after 7 days).
2. The **Gmail API** is enabled (APIs & Services → Library → Gmail API → Enable).
3. Scope: `https://mail.google.com/` works; if you only need to send, use the least-privilege scope
   `https://www.googleapis.com/auth/gmail.send`.
4. Obtain a refresh token with the OAuth Playground:
   - Gear icon (top right) → check **Use your own OAuth credentials** and enter your Client ID / Secret
   - Your OAuth client's *Authorized redirect URIs* must include `https://developers.google.com/oauthplayground`
   - Step 1 select scope → Authorize → Step 2 **Exchange authorization code for tokens** → copy `refresh_token`

> ⚠️ The client secret, refresh token and access token are secrets. Keep them only in Vercel environment variables; never commit them to git or post them publicly.
> If they have leaked, reset the client secret in Cloud Console, revoke the old grant at <https://myaccount.google.com/permissions>, then obtain a new token.

## 2. Vercel Environment Variables (enter manually)

Vercel Dashboard → your Project → **Settings → Environment Variables**, add each of:

| Variable | Required | Example / Description |
| --- | --- | --- |
| `GMAIL_CLIENT_ID` | ✅ | `xxxxxxxx.apps.googleusercontent.com` |
| `GMAIL_CLIENT_SECRET` | ✅ | `GOCSPX-…` (mark as *Sensitive*) |
| `GMAIL_REFRESH_TOKEN` | ✅ | `1//0…` (mark as *Sensitive*) |
| `GMAIL_SENDER` | ✅ | The authorized Gmail account, e.g. `you@gmail.com`. May also be a "Send mail as" alias configured in that account's Gmail settings |
| `API_KEY` | ✅ | Key for calling this API; use a long random string, e.g. generated with `openssl rand -hex 32` |
| `DEFAULT_FROM_NAME` | ⬜ | Default sender display name, e.g. `Notifications` |
| `ALLOW_URL_ATTACHMENTS` | ⬜ | Set to `true` to allow `href` (https URL) attachments downloaded by the server; disabled by default |

You must **Redeploy** after adding or changing environment variables.

## Pre-launch Checklist

- [ ] **If secrets have ever leaked (pasted into chat, screenshots, committed to git), rotate them first**: reset the client secret in Cloud Console →
      revoke the old grant at <https://myaccount.google.com/permissions> → obtain a new refresh token
- [ ] OAuth consent screen is **In production**, and the refresh token was obtained **after** publishing (otherwise it expires in 7 days)
- [ ] Gmail API is enabled
- [ ] (Recommended) scope reduced to `https://www.googleapis.com/auth/gmail.send`
- [ ] All 5 required environment variables are set in Vercel, with Client Secret / Refresh Token marked *Sensitive*
- [ ] `API_KEY` is a long random string and lives only on the caller's backend, never in frontend code
- [ ] Redeployed after setting environment variables

## Post-deployment Verification

1. Check the token works (sends nothing):

```bash
curl https://<your-app>.vercel.app/api/health -H "Authorization: Bearer $API_KEY"
```

   Expected response: `{"ok":true,"sender":"you@gmail.com"}`. If you see `invalid_grant`, obtain a new refresh token.

2. Send yourself a test email:

```bash
curl -X POST https://<your-app>.vercel.app/api/send -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"to":"you@gmail.com","subject":"vercel-mail test","text":"Plain text","html":"<b>HTML</b> content"}'
```

   > **Windows (cmd.exe / PowerShell)**: cmd does not support single quotes, so the JSON above gets split and the body becomes invalid JSON.
   > Save the JSON as a UTF-8 file (e.g. `body.json`) and send it with `-d @body.json` (in PowerShell use `curl.exe` instead of `curl`):
   >
   > ```bash
   > curl.exe -X POST https://<your-app>.vercel.app/api/send -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d @body.json
   > ```
   >
   > `<API_KEY>` is the `API_KEY` value you set in Vercel — **not** a Google access token (`ya29.…`).

3. Check Gmail's "Sent" folder, then test attachments and inline images as needed (see examples below).

## 3. Deployment

```bash
npm i -g vercel
```

```bash
vercel link
```

```bash
vercel --prod
```

Or push this repo to GitHub and use *Import Project* on Vercel (Framework Preset: **Other**, no build command).

Local development: copy `.env.example` to `.env.local` and fill in values (or run `vercel env pull .env.local`), then:

```bash
vercel dev
```

## 4. API

### Authentication

Every endpoint requires one of these headers:

```
Authorization: Bearer <API_KEY>
X-API-Key: <API_KEY>
```

> Never put API_KEY in browser frontend code; call this API from your own backend.

### `GET /api/health`

Checks configuration and that the refresh token is valid. Success: `{ "ok": true, "sender": "you@gmail.com" }`

### `POST /api/send`

`Content-Type: application/json`

| Field | Type | Description |
| --- | --- | --- |
| `to` / `cc` / `bcc` | string \| `{name,address}` \| array | At least one is required. Strings may be `"a@x.com"`, `"Jane Doe <a@x.com>"` or comma-separated |
| `replyTo` | same as above | Reply-to address |
| `subject` | string | Subject (Unicode and emoji supported) |
| `text` | string | Plain-text body |
| `html` | string | HTML body; `<img src="data:image/png;base64,...">` is automatically converted to an inline attachment |
| `fromName` | string | Sender display name (overrides `DEFAULT_FROM_NAME`). The sender address is always `GMAIL_SENDER` |
| `attachments` | array | See table below |
| `headers` | object | Custom headers, e.g. `{ "X-Campaign": "oct" }` |
| `priority` | `"high"` \| `"normal"` \| `"low"` | Importance |
| `inReplyTo` / `references` | string | Message-IDs for replying within a thread |

At least one of `text`, `html`, `attachments` is required; providing both `text` and `html` is recommended.

**attachments[]**

| Field | Description |
| --- | --- |
| `filename` | Filename (Unicode supported) |
| `content` | File content as a string, treated as base64 by default |
| `encoding` | `base64` (default), `utf8`, `hex`… |
| `contentType` | MIME type; inferred from filename if omitted |
| `cid` | Makes it an inline image, referenced in HTML as `<img src="cid:<cid>">` |
| `href` | Download the attachment from an https URL instead (requires `ALLOW_URL_ATTACHMENTS=true`); mutually exclusive with `content` |
| `contentDisposition` | `attachment` or `inline` |

Success response:

```json
{ "ok": true, "id": "18f…", "threadId": "18f…", "size": 12345 }
```

Error response: `{ "ok": false, "error": "…", "details": { … } }`, status 400 / 401 / 405 / 413 / 502.

### Examples

Plain text:

```bash
curl -X POST https://<your-app>.vercel.app/api/send -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"to":"someone@example.com","subject":"Hello","text":"Hi there"}'
```

HTML + inline image + attachments + multiple recipients:

```json
{
  "to": ["a@example.com", { "name": "Jane Doe", "address": "b@example.com" }],
  "cc": "c@example.com",
  "bcc": ["audit@example.com"],
  "replyTo": "support@example.com",
  "fromName": "Notifications",
  "subject": "October Report 📊",
  "text": "Hello, the October report is attached.",
  "html": "<h1>October Report</h1><p>Hello,</p><img src=\"cid:logo\" width=\"120\">",
  "attachments": [
    { "filename": "logo.png", "content": "<base64>", "cid": "logo" },
    { "filename": "report.pdf", "content": "<base64>", "contentType": "application/pdf" },
    { "filename": "data.csv", "content": "a,b\n1,2", "encoding": "utf8" },
    { "filename": "remote.zip", "href": "https://example.com/files/remote.zip" }
  ]
}
```

Node.js caller:

```js
import { readFile } from 'node:fs/promises';

const res = await fetch('https://<your-app>.vercel.app/api/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    to: 'someone@example.com',
    subject: 'Attachment test',
    html: '<p>Please see the attachment</p>',
    attachments: [{ filename: 'a.pdf', content: (await readFile('a.pdf')).toString('base64') }],
  }),
});
console.log(await res.json());
```

## 5. Limitations and Notes

- **Request size**: Vercel Function request body limit is **4.5 MB**; base64 inflates data by ~33%, so attachments embedded in JSON should total under about **3 MB**.
  For larger files, host them at a publicly downloadable https URL and use `href` (with `ALLOW_URL_ATTACHMENTS=true`).
- **Gmail limits**: 35 MB per message (including attachments); daily sending quota is about 500 for personal Gmail and about 2,000 for Workspace.
- **Sender address**: Gmail only allows sending as the authorized account or a configured "Send mail as" alias; other addresses get rewritten, so `from` is always determined by `GMAIL_SENDER`.
- **Security**: The server never reads local files (`disableFileAccess`); URL attachments are disabled by default and only https is allowed.
- **Refresh token invalid** (response contains `invalid_grant`): usually the 7-day expiry in Testing status, a revoked grant, or a changed password / client secret. Obtain a new token, update `GMAIL_REFRESH_TOKEN`, and Redeploy.
- Max execution time is set to 30 seconds in `vercel.json` (available on the Hobby plan).

## 6. Deliverability (Avoiding the Junk Folder)

Mail is sent from Google's servers as `@gmail.com`, so SPF / DKIM / DMARC are handled by Google and normally pass.
If messages land in junk (e.g. Outlook / Hotmail), the cause is usually sender reputation or content, not this API.

### Common causes

1. **First contact**: the recipient has never exchanged mail with this Gmail account, so trust is low.
2. **Thin content**: very short, low-information messages (e.g. "test") are easily flagged.
3. **Personal Gmail as a system sender**: Microsoft is stricter with automated-looking mail from free mailbox providers.

### Improvements (easiest first)

1. **Recipient marks it "Not junk"** and adds the sender to Safe Senders — the most effective fix for a given recipient.
2. **Send meaningful content**: a specific subject, both `text` and `html` with matching content; avoid one-word bodies, image-only mail or link-only mail.
3. **For bulk or unknown recipients**: use Google Workspace with your own domain (e.g. `noreply@yourdomain.com`) and configure SPF / DKIM / DMARC,
   or for high volume switch to a transactional email service (SendGrid, Amazon SES, Resend, etc.). Personal Gmail is not meant for bulk mail (~500/day).

### Diagnosing (Outlook)

Open the message → *View → View message source* (or *… → View → View message details*) and check:

| Header | What to look for |
| --- | --- |
| `Authentication-Results` | `spf=`, `dkim=`, `dmarc=` should all be `pass` |
| `X-MS-Exchange-Organization-SCL` | Spam confidence level; 5 or higher goes to junk |
| `X-Forefront-Antispam-Report` | `SFV:` (filter verdict), `SCL:`, `CAT:` (category) |

Authentication failures point to a sender/domain setup issue; passing authentication with a high SCL points to content or reputation.
