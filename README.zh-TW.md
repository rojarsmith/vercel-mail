# vercel-mail

[English](README.md) | **繁體中文**

部署在 [Vercel](https://vercel.com/) 上的 RESTful API，使用 Google OAuth2（refresh token）透過 **Gmail API** 寄信。
支援純文字、HTML、內嵌圖片（CID / data URI）、附件、多收件人、CC/BCC、Reply-To、自訂標頭等。

## 技術可行性評估

結論：**可行**。

| 項目 | 評估 |
| --- | --- |
| 執行環境 | Vercel Serverless Function（Node.js ≥ 20，內建 `fetch`），不需框架、不需 build |
| 認證方式 | 使用 OAuth2 refresh token 向 `oauth2.googleapis.com/token` 換取 access token（有效 1 小時，函式暖機期間會快取），不需安裝 `googleapis` 套件 |
| 信件組裝 | **Nodemailer** 負責組出標準 MIME：純文字、HTML、附件、內嵌圖片（CID / data URI）、中文主旨與檔名、CC/BCC 等多元格式 |
| 寄送通道 | **Gmail API（HTTPS）** `users.messages.send`，以 `message/rfc822` 直接上傳原始信件，不使用 SMTP |
| 為何不用 SMTP | Serverless 環境中 SMTP 連線較容易逾時或被擋；HTTPS 較穩定，且 Gmail API 支援單封 35 MB |
| 主要限制 | Vercel 請求 body 上限 4.5 MB → JSON 內嵌 base64 附件合計約 3 MB；更大檔案改用 `href` 網址附件 |
| 已驗證 | MIME 組裝（多收件人、中文、內嵌圖、附件、BCC 保留）、輸入驗證、API Key 驗證、錯誤處理已在本機測試；實際寄送需設定好 Vercel 環境變數後以 `/api/health` 與 `/api/send` 驗證 |

## 架構

```
Client ──POST /api/send (Bearer API_KEY, JSON)──▶ Vercel Function
                                                  │ 1. Nodemailer 組出 MIME（HTML/附件/內嵌圖）
                                                  │ 2. 用 refresh token 換 access token（暖機期間快取）
                                                  ▼ 3. POST gmail.googleapis.com …/messages/send (message/rfc822)
                                               Gmail
```

## 檔案

| 路徑 | 說明 |
| --- | --- |
| `api/send.js` | `POST /api/send` 寄信 |
| `api/health.js` | `GET /api/health` 檢查環境變數與 refresh token 是否仍可用（不寄信） |
| `lib/mailer.js` | 驗證、OAuth token、MIME 組裝、Gmail API 呼叫 |
| `.env.example` | 環境變數範本（本機 `vercel dev` 用） |

---

## 一、Google 端設定（必做檢查）

1. **OAuth 同意畫面發布狀態要改成「In production（正式版）」**
   你目前拿到的 `refresh_token_expires_in: 604799`（約 7 天）代表 App 仍在 **Testing** 狀態，
   refresh token 7 天後就會失效。到 Google Cloud Console → *Google Auth Platform* → *Audience* →
   **Publish app**（詳細步驟見下方 [發布應用程式](#發布應用程式)）。
   發布後**要重新取得一次 refresh token**（舊的仍會在 7 天後過期）。
2. 已啟用 **Gmail API**（APIs & Services → Library → Gmail API → Enable）。
3. Scope：目前用 `https://mail.google.com/` 可以運作；若只需寄信，建議改用最小權限
   `https://www.googleapis.com/auth/gmail.send`。
4. 用 OAuth Playground 重新取得 refresh token：
   - 右上齒輪 → 勾選 **Use your own OAuth credentials**，填入你的 Client ID / Secret
   - 你的 OAuth Client 的 *Authorized redirect URIs* 需包含 `https://developers.google.com/oauthplayground`
   - Step 1 選 scope → Authorize → Step 2 **Exchange authorization code for tokens** → 複製 `refresh_token`

### 發布應用程式

只給自己用的話**不需要**送 Google 審核，「未經驗證」的正式版 App 即可正常使用。

1. **品牌（Branding）頁——網址欄位留空**
   Google Auth Platform →「品牌」：「應用程式首頁」「應用程式隱私權政策連結」「應用程式服務條款連結」三個欄位**全部留空**
   （本 API 根目錄本來就沒有網頁）。只要有填網址，該網域就必須列在「授權網域」中，否則會出現 `缺少網域：<your-app>.vercel.app` 的錯誤。
   - 替代做法：保留網址，並在「授權網域」新增該網域（例如 `<your-app>.vercel.app`）。只有要送審時才需要到 Search Console 驗證網域。
2. **目標對象（Audience）頁——發布**
   Google Auth Platform →「目標對象」→ **發布應用程式（Publish app）** → 確認。狀態變為 **實際運作中（In production）**，可能顯示「需要驗證」或「未經驗證」，不影響使用：
   - 未驗證的 App 最多 100 位使用者，個人使用綽綽有餘。
   - 授權時會出現「Google 尚未驗證這個應用程式」，點「進階」→「前往…（不安全）」即可。
   - 發布後重新取得的 refresh token 不會再 7 天過期。
3. **重新取得 refresh token**
   再用 OAuth Playground（上方第 4 點）取得新的 token，建議 scope 改用 `https://www.googleapis.com/auth/gmail.send`，
   更新 Vercel 的 `GMAIL_REFRESH_TOKEN` 後 Redeploy。舊 token 仍會依原本的 7 天到期。
4. 用 `GET /api/health` 驗證（見 [部署後驗證](#部署後驗證)）。

> ⚠️ Client Secret、refresh token、access token 都是機密，請只放在 Vercel 環境變數中，不要提交到 git 或貼到公開地方。
> 若曾外流，請到 Cloud Console 重設 Client Secret，並到 <https://myaccount.google.com/permissions> 撤銷舊授權後重新取得。

## 二、Vercel 環境變數（手動輸入）

Vercel Dashboard → 你的 Project → **Settings → Environment Variables**，逐一新增：

| 變數 | 必填 | 範例 / 說明 |
| --- | --- | --- |
| `GMAIL_CLIENT_ID` | ✅ | `xxxxxxxx.apps.googleusercontent.com` |
| `GMAIL_CLIENT_SECRET` | ✅ | `GOCSPX-…`（建議勾選 *Sensitive*） |
| `GMAIL_REFRESH_TOKEN` | ✅ | `1//0…`（建議勾選 *Sensitive*） |
| `GMAIL_SENDER` | ✅ | 授權的 Gmail 帳號，例如 `you@gmail.com`。也可填該帳號在 Gmail 設定過的「傳送郵件身分」別名 |
| `API_KEY` | ✅ | 呼叫本 API 用的金鑰，請用長亂數，例如 `openssl rand -hex 32` 產生 |
| `DEFAULT_FROM_NAME` | ⬜ | 寄件人顯示名稱預設值，例如 `系統通知` |
| `ALLOW_URL_ATTACHMENTS` | ⬜ | `true` 才允許附件用 `href`（https 網址）讓伺服器下載，預設關閉 |

新增或修改環境變數後需要 **Redeploy** 才會生效。

## 上線前檢查清單

- [ ] **機密若曾外流（例如貼到聊天、截圖、提交到 git），先輪替**：Cloud Console 重設 Client Secret →
      <https://myaccount.google.com/permissions> 撤銷舊授權 → 重新取得 refresh token
- [ ] OAuth 同意畫面已改為 **In production**，並在發布**之後**重新取得 refresh token（否則 7 天後失效）
- [ ] 已啟用 Gmail API
- [ ] （建議）scope 改為最小權限 `https://www.googleapis.com/auth/gmail.send`
- [ ] Vercel 已填入 5 個必填環境變數，Client Secret / Refresh Token 勾選 *Sensitive*
- [ ] `API_KEY` 為長亂數，且只存在於呼叫端後端，不放在前端程式
- [ ] 環境變數設定後已 Redeploy

## 部署後驗證

1. 確認 token 正常（不寄信）：

```bash
curl https://<your-app>.vercel.app/api/health -H "Authorization: Bearer $API_KEY"
```

   預期回應 `{"ok":true,"sender":"you@gmail.com"}`；若出現 `invalid_grant` 請重新取得 refresh token。

2. 寄一封測試信給自己：

```bash
curl -X POST https://<your-app>.vercel.app/api/send -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"to":"you@gmail.com","subject":"vercel-mail 測試","text":"純文字","html":"<b>HTML</b> 內容"}'
```

   > **Windows（cmd.exe / PowerShell）**：cmd 不支援單引號，上面的 JSON 會被拆開導致 body 不是合法 JSON。
   > 請把 JSON 存成 UTF-8 檔案（例如 `body.json`），用 `-d @body.json` 送出（PowerShell 請用 `curl.exe` 而非 `curl`）：
   >
   > ```bash
   > curl.exe -X POST https://<your-app>.vercel.app/api/send -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d @body.json
   > ```
   >
   > `<API_KEY>` 是你在 Vercel 設定的 `API_KEY` 值，**不是** Google 的 access token（`ya29.…`）。

3. 到 Gmail「寄件備份」確認信件、再依需要測試附件與內嵌圖片（見下方範例）。

## 三、部署

```bash
npm i -g vercel
```

```bash
vercel link
```

```bash
vercel --prod
```

或直接把此 repo 推到 GitHub，在 Vercel 上 *Import Project*（Framework Preset 選 **Other**，不需 build command）。

本機開發：把 `.env.example` 複製為 `.env.local` 填入值（或 `vercel env pull .env.local`），然後：

```bash
vercel dev
```

## 四、API

### 驗證

所有端點需帶以下任一標頭：

```
Authorization: Bearer <API_KEY>
X-API-Key: <API_KEY>
```

> API_KEY 不能放在瀏覽器前端程式中，請從你自己的後端呼叫此 API。

### `GET /api/health`

確認設定與 refresh token 是否有效。成功：`{ "ok": true, "sender": "you@gmail.com" }`

### `POST /api/send`

`Content-Type: application/json`

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `to` / `cc` / `bcc` | string \| `{name,address}` \| 陣列 | 至少需要其中一個。字串可為 `"a@x.com"`、`"王小明 <a@x.com>"` 或逗號分隔 |
| `replyTo` | 同上 | 回覆地址 |
| `subject` | string | 主旨（支援中文、emoji） |
| `text` | string | 純文字內容 |
| `html` | string | HTML 內容；`<img src="data:image/png;base64,...">` 會自動轉為內嵌附件 |
| `fromName` | string | 寄件人顯示名稱（覆寫 `DEFAULT_FROM_NAME`）。寄件地址固定為 `GMAIL_SENDER` |
| `attachments` | 陣列 | 見下表 |
| `headers` | object | 自訂標頭，例如 `{ "X-Campaign": "oct" }` |
| `priority` | `"high"` \| `"normal"` \| `"low"` | 重要性 |
| `inReplyTo` / `references` | string | 回覆討論串用的 Message-ID |

`text`、`html`、`attachments` 至少要有一個；建議同時提供 `text` 與 `html`。

**attachments[]**

| 欄位 | 說明 |
| --- | --- |
| `filename` | 檔名（支援中文） |
| `content` | 檔案內容字串，預設視為 base64 |
| `encoding` | `base64`（預設）、`utf8`、`hex`… |
| `contentType` | MIME type，省略時依檔名推斷 |
| `cid` | 設定後即為內嵌圖片，HTML 以 `<img src="cid:<cid>">` 引用 |
| `href` | 改用 https 網址下載附件（需 `ALLOW_URL_ATTACHMENTS=true`），與 `content` 擇一 |
| `contentDisposition` | `attachment` 或 `inline` |

成功回應：

```json
{ "ok": true, "id": "18f…", "threadId": "18f…", "size": 12345 }
```

錯誤回應：`{ "ok": false, "error": "…", "details": { … } }`，狀態碼 400 / 401 / 405 / 413 / 502。

### 範例

純文字：

```bash
curl -X POST https://<your-app>.vercel.app/api/send -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"to":"someone@example.com","subject":"Hello","text":"Hi there"}'
```

HTML + 內嵌圖片 + 附件 + 多收件人：

```json
{
  "to": ["a@example.com", { "name": "王小明", "address": "b@example.com" }],
  "cc": "c@example.com",
  "bcc": ["audit@example.com"],
  "replyTo": "support@example.com",
  "fromName": "系統通知",
  "subject": "十月報表 📊",
  "text": "您好，附件為十月報表。",
  "html": "<h1>十月報表</h1><p>您好：</p><img src=\"cid:logo\" width=\"120\">",
  "attachments": [
    { "filename": "logo.png", "content": "<base64>", "cid": "logo" },
    { "filename": "報表.pdf", "content": "<base64>", "contentType": "application/pdf" },
    { "filename": "data.csv", "content": "a,b\n1,2", "encoding": "utf8" },
    { "filename": "remote.zip", "href": "https://example.com/files/remote.zip" }
  ]
}
```

Node.js 呼叫端：

```js
import { readFile } from 'node:fs/promises';

const res = await fetch('https://<your-app>.vercel.app/api/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    to: 'someone@example.com',
    subject: '附件測試',
    html: '<p>請見附件</p>',
    attachments: [{ filename: 'a.pdf', content: (await readFile('a.pdf')).toString('base64') }],
  }),
});
console.log(await res.json());
```

## 五、限制與注意事項

- **請求大小**：Vercel Function 請求 body 上限 **4.5 MB**，base64 會膨脹約 33%，所以內嵌於 JSON 的附件合計約 **3 MB** 以內。
  更大的檔案請先放到可公開 https 下載的位置，再用 `href`（並設 `ALLOW_URL_ATTACHMENTS=true`）。
- **Gmail 上限**：單封信（含附件）35 MB；每日寄送量個人 Gmail 約 500 封、Workspace 約 2000 封。
- **寄件地址**：Gmail 只允許用授權帳號本身或已設定的「傳送郵件身分」別名寄出，其他地址會被改寫，因此 `from` 固定由 `GMAIL_SENDER` 決定。
- **安全**：伺服器不讀取本機檔案（`disableFileAccess`），URL 附件預設停用且只允許 https。
- **refresh token 失效**（回應含 `invalid_grant`）：通常是 Testing 狀態 7 天過期、使用者撤銷授權、或改了密碼／Client Secret，請重新取得並更新 `GMAIL_REFRESH_TOKEN` 後 Redeploy。
- 執行時間上限在 `vercel.json` 設為 30 秒（Hobby 方案可用）。

## 六、寄信品質（避免被歸類為垃圾郵件）

信件由 Google 伺服器以 `@gmail.com` 寄出，SPF / DKIM / DMARC 由 Google 處理，通常都會通過。
若被收件端（例如 Outlook / Hotmail）歸類為垃圾郵件，原因多半是寄件者信譽或信件內容，而非本 API。

### 常見原因

1. **第一次往來**：收件者與此 Gmail 帳號從未往來，信任度低。
2. **內容過於單薄**：極短、沒有實質資訊的信（例如「測試」）容易被判定為垃圾信。
3. **用個人 Gmail 當系統寄件者**：Microsoft 對免費信箱寄出、看起來像自動通知的信件較嚴格。

### 改善方式（由簡到難）

1. **收件者標記「非垃圾郵件」**並將寄件者加入安全寄件者清單——對特定收件者最有效。
2. **寄送有實質內容的信**：主旨具體、同時提供內容一致的 `text` 與 `html`；避免一兩個字的內文、整封只有圖片或只有連結。
3. **大量寄送或寄給不認識的收件者**：改用 Google Workspace 綁自己的網域（例如 `noreply@yourdomain.com`）並設定 SPF / DKIM / DMARC；
   量大時改用交易信服務（SendGrid、Amazon SES、Resend 等）。個人 Gmail 不適合大量寄信（每日約 500 封）。

### 診斷方式（Outlook）

開啟信件 →「檢視 → 檢視郵件來源」（或「… → 檢視 → 檢視郵件詳細資料」），檢查：

| 標頭 | 檢查重點 |
| --- | --- |
| `Authentication-Results` | `spf=`、`dkim=`、`dmarc=` 是否皆為 `pass` |
| `X-MS-Exchange-Organization-SCL` | 垃圾信信賴等級，5 以上會進垃圾郵件 |
| `X-Forefront-Antispam-Report` | `SFV:`（篩選結果）、`SCL:`、`CAT:`（分類） |

驗證失敗代表寄件者／網域設定問題；驗證通過但 SCL 偏高則代表內容或信譽問題。
