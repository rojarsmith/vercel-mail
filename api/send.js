import { buildMailOptions, buildRawMessage, checkApiKey, HttpError, sendError, sendRawMessage } from '../lib/mailer.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new HttpError(405, 'Method not allowed');
    }
    checkApiKey(req);

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    }

    const raw = await buildRawMessage(buildMailOptions(body));
    const result = await sendRawMessage(raw);
    res.status(200).json({ ok: true, id: result.id, threadId: result.threadId, size: raw.length });
  } catch (err) {
    sendError(res, err);
  }
}
