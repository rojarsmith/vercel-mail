import { checkApiKey, env, getAccessToken, HttpError, sendError } from '../lib/mailer.js';

// Verifies env vars and that the refresh token can still obtain an access token (sends nothing).
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, 'Method not allowed');
    }
    checkApiKey(req);
    await getAccessToken({ force: true });
    res.status(200).json({ ok: true, sender: env('GMAIL_SENDER') });
  } catch (err) {
    sendError(res, err);
  }
}
