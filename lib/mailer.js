import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';
const GMAIL_MAX_BYTES = 35 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function env(name, { required = true } = {}) {
  const value = process.env[name];
  if (required && !value) throw new HttpError(500, `Server misconfigured: missing env ${name}`);
  return value;
}

// ---------- API key auth ----------

export function checkApiKey(req) {
  const expected = env('API_KEY');
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'] || '';
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!provided || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
}

// ---------- OAuth2 access token (cached across warm invocations) ----------

let cachedToken = null; // { value, expiresAt }

export async function getAccessToken({ force = false } = {}) {
  if (!force && cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GMAIL_CLIENT_ID'),
      client_secret: env('GMAIL_CLIENT_SECRET'),
      refresh_token: env('GMAIL_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const hint =
      data.error === 'invalid_grant'
        ? 'Refresh token expired or revoked. Re-issue it (see README: OAuth consent screen must be "In production" to avoid 7-day expiry).'
        : undefined;
    throw new HttpError(502, `Failed to refresh Google access token: ${data.error || res.status}`, {
      error_description: data.error_description,
      hint,
    });
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

// ---------- Request validation ----------

const ATTACHMENT_FIELDS = ['filename', 'content', 'encoding', 'contentType', 'cid', 'href', 'contentDisposition'];

function asAddressList(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    const ok =
      typeof item === 'string' ||
      (item && typeof item === 'object' && typeof item.address === 'string' && (item.name === undefined || typeof item.name === 'string'));
    if (!ok) throw new HttpError(400, `"${field}" must be a string, {name,address} or an array of them`);
  }
  return list;
}

function sanitizeAttachment(att, index) {
  if (!att || typeof att !== 'object') throw new HttpError(400, `attachments[${index}] must be an object`);
  const out = {};
  for (const key of ATTACHMENT_FIELDS) if (att[key] !== undefined) out[key] = att[key];

  if (out.href !== undefined) {
    if (process.env.ALLOW_URL_ATTACHMENTS !== 'true') {
      throw new HttpError(400, `attachments[${index}].href is disabled (set ALLOW_URL_ATTACHMENTS=true to enable)`);
    }
    let url;
    try {
      url = new URL(out.href);
    } catch {
      throw new HttpError(400, `attachments[${index}].href is not a valid URL`);
    }
    if (url.protocol !== 'https:') throw new HttpError(400, `attachments[${index}].href must be https`);
    delete out.content;
    delete out.encoding;
  } else {
    if (typeof out.content !== 'string') {
      throw new HttpError(400, `attachments[${index}] needs "content" (string) or "href"`);
    }
    out.encoding = out.encoding || 'base64';
    if (!['base64', 'utf8', 'utf-8', 'hex', 'binary', 'latin1'].includes(out.encoding)) {
      throw new HttpError(400, `attachments[${index}].encoding is not supported`);
    }
  }
  if (out.cid !== undefined && typeof out.cid !== 'string') throw new HttpError(400, `attachments[${index}].cid must be a string`);
  if (out.contentDisposition !== undefined && !['attachment', 'inline'].includes(out.contentDisposition)) {
    throw new HttpError(400, `attachments[${index}].contentDisposition must be "attachment" or "inline"`);
  }
  return out;
}

export function buildMailOptions(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON body required');

  const to = asAddressList(body.to, 'to');
  const cc = asAddressList(body.cc, 'cc');
  const bcc = asAddressList(body.bcc, 'bcc');
  if (!to && !cc && !bcc) throw new HttpError(400, 'At least one of "to", "cc", "bcc" is required');

  for (const field of ['subject', 'text', 'html', 'fromName']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') throw new HttpError(400, `"${field}" must be a string`);
  }
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) throw new HttpError(400, '"attachments" must be an array');
  const attachments = (body.attachments || []).map(sanitizeAttachment);
  if (!body.text && !body.html && attachments.length === 0) throw new HttpError(400, 'Provide "text", "html" or "attachments"');

  let headers;
  if (body.headers !== undefined) {
    if (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers)) {
      throw new HttpError(400, '"headers" must be an object of string values');
    }
    headers = {};
    for (const [k, v] of Object.entries(body.headers)) {
      if (typeof v !== 'string' || /[\r\n]/.test(k + v)) throw new HttpError(400, `Invalid header "${k}"`);
      headers[k] = v;
    }
  }

  const sender = env('GMAIL_SENDER');
  const fromName = body.fromName ?? process.env.DEFAULT_FROM_NAME;

  return {
    from: fromName ? { name: fromName, address: sender } : sender,
    to,
    cc,
    bcc,
    replyTo: asAddressList(body.replyTo, 'replyTo'),
    subject: body.subject || '',
    text: body.text,
    html: body.html,
    attachments,
    headers,
    priority: ['high', 'normal', 'low'].includes(body.priority) ? body.priority : undefined,
    inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : undefined,
    references: typeof body.references === 'string' || Array.isArray(body.references) ? body.references : undefined,
    // Convert <img src="data:image/...;base64,..."> in html into inline CID attachments
    attachDataUrls: true,
    // Never let request data read the server's filesystem; URL fetching only when explicitly enabled
    disableFileAccess: true,
    disableUrlAccess: process.env.ALLOW_URL_ATTACHMENTS !== 'true',
  };
}

// ---------- Build MIME + send via Gmail API ----------

const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });

export async function buildRawMessage(mailOptions) {
  try {
    const info = await composer.sendMail(mailOptions);
    return info.message; // Buffer containing the full RFC 822 message
  } catch (err) {
    throw new HttpError(400, `Failed to build message: ${err.message}`);
  }
}

export async function sendRawMessage(raw) {
  if (raw.length > GMAIL_MAX_BYTES) throw new HttpError(413, 'Message exceeds Gmail 35MB limit');

  const post = async (token) =>
    fetch(SEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'message/rfc822' },
      body: raw,
    });

  let res = await post(await getAccessToken());
  if (res.status === 401) res = await post(await getAccessToken({ force: true }));

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(res.status >= 500 ? 502 : res.status, `Gmail API error: ${data.error?.message || res.status}`, data.error);
  }
  return data; // { id, threadId, labelIds }
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    ok: false,
    error: err instanceof HttpError ? err.message : 'Internal server error',
    ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
  });
}
