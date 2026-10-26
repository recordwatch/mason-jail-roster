import express from 'express';
import fs from 'fs';
import { RESEND_API_KEY, CONTACT_TO, CONTACT_FROM, CONTACT_LOG_FILE } from '../config.js';

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Name and email are optional: people writing about their own booking record
// may not want to identify themselves, and a blank email just means no reply.
export function validateContact(body) {
  const name = String(body?.name ?? '').trim();
  const email = String(body?.email ?? '').trim();
  const message = String(body?.message ?? '').trim();
  const values = { name, email, message };

  if (name.length > MAX_NAME) return { error: `Name must be ${MAX_NAME} characters or fewer.`, values };
  if (email && (email.length > MAX_EMAIL || !EMAIL_RE.test(email))) return { error: 'That email address doesn\'t look right.', values };
  if (message.length < MIN_MESSAGE) return { error: 'Please write a message (at least a few words).', values };
  if (message.length > MAX_MESSAGE) return { error: `Message must be ${MAX_MESSAGE.toLocaleString()} characters or fewer.`, values };
  return { values };
}

// Fixed-window per-IP limit, in memory. Resets on restart, which is fine for
// a soft spam brake on a site this size.
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return function isLimited(ip, now = Date.now()) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const entry = hits.get(ip) ?? { count: 0, resetAt: now + windowMs };
    entry.count++;
    hits.set(ip, entry);
    return entry.count > max;
  };
}

// Traffic arrives via Cloudflare → Railway, so req.ip is a proxy address.
// CF-Connecting-IP can be spoofed by anyone hitting the Railway URL directly,
// which only matters for the rate limit — acceptable for a soft brake.
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip;
}

export async function sendViaResend({ name, email, message }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: CONTACT_FROM,
      to: [CONTACT_TO],
      subject: `wajaildata.org contact${name ? ` from ${name}` : ''}`,
      text: `Name: ${name || '(not given)'}\nEmail: ${email || '(not given)'}\n\n${message}`,
      ...(email ? { reply_to: email } : {}),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export function readContactLog(logFile = CONTACT_LOG_FILE) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export function renderContactPage({ error = '', sent = false, values = {} } = {}) {
  const v = k => escapeHtml(values[k] ?? '');
  const body = sent
    ? `<div class="notice ok">Thanks — your message was received.</div>
    <a class="back" href="/api/status">← Back to Washington Jail Data</a>`
    : `${error ? `<div class="notice err">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/contact">
      <label><span>Name <span class="opt">optional</span></span>
        <input type="text" name="name" maxlength="${MAX_NAME}" autocomplete="name" value="${v('name')}">
      </label>
      <label><span>Email <span class="opt">optional — leave blank if you don't need a reply</span></span>
        <input type="email" name="email" maxlength="${MAX_EMAIL}" autocomplete="email" value="${v('email')}">
      </label>
      <label>Message
        <textarea name="message" rows="8" required minlength="${MIN_MESSAGE}" maxlength="${MAX_MESSAGE}">${v('message')}</textarea>
      </label>
      <div class="hp" aria-hidden="true">
        <label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <button type="submit">Send message</button>
    </form>
    <p class="alt">Or email <a href="mailto:${escapeHtml(CONTACT_TO)}">${escapeHtml(CONTACT_TO)}</a> directly.</p>
    <a class="back" href="/api/status">← Back to Washington Jail Data</a>`;

  return `<!DOCTYPE html>
<html>
<head>
  <title>Contact — Washington Jail Data</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', Arial, sans-serif; font-size: 9pt; background: #121A15; color: #C9D3C2; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
    .wrapper { width: 100%; max-width: 520px; }
    .county-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #A9BE9C; margin-bottom: 0.5rem; }
    h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 2.5rem; font-weight: 700; color: #E7EBDF; letter-spacing: -1px; line-height: 1.1; margin-bottom: 0.5rem; }
    .intro { color: #83937C; margin-bottom: 1rem; line-height: 1.5; }
    form { background: #1B2A20; border: 1px solid #2E4433; border-radius: 6px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.9rem; }
    label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.7rem; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #A9BE9C; }
    .opt { margin-left: 0.35rem; font-weight: 400; letter-spacing: 0; text-transform: none; color: #83937C; }
    input, textarea { font: inherit; font-size: 10pt; text-transform: none; letter-spacing: 0; font-weight: 400; color: #E7EBDF; background: #121A15; border: 1px solid #2E4433; border-radius: 4px; padding: 0.55rem 0.7rem; width: 100%; }
    input:focus, textarea:focus { outline: none; border-color: #547048; }
    textarea { resize: vertical; min-height: 8rem; }
    button { font: inherit; font-weight: 600; font-size: 9pt; padding: 0.75rem 1.25rem; background: #547048; color: #E7EBDF; border: 0; border-radius: 6px; cursor: pointer; align-self: flex-start; }
    button:hover { background: #64835A; }
    .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    .notice { border-radius: 6px; padding: 0.85rem 1.25rem; margin-bottom: 0.75rem; border: 1px solid; }
    .notice.ok { background: #1B2A20; border-color: #547048; color: #E7EBDF; }
    .notice.err { background: #2A1B1B; border-color: #6B3434; color: #F0C9C9; }
    .alt { margin-top: 0.75rem; color: #83937C; }
    a { color: #A9BE9C; text-decoration: none; }
    .back { display: inline-block; margin-top: 1rem; font-size: 0.75rem; }
    @media (max-width: 600px) { h1 { font-size: 1.75rem; } }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="county-label">Washington Jail Data</div>
    <h1>Contact</h1>
    <p class="intro">Questions, corrections, or a jail roster we should be monitoring? Send a note.</p>
    ${body}
  </div>
</body>
</html>`;
}

export function createContactRouter({
  logFile = CONTACT_LOG_FILE,
  sendEmail = sendViaResend,
  isLimited = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
} = {}) {
  const router = express.Router();

  router.get('/contact', (req, res) => {
    res.send(renderContactPage());
  });

  router.post('/contact', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    // Honeypot: real visitors never see the website field. Bots that fill it
    // get the same success page so they don't learn to skip it.
    if (req.body?.website) return res.send(renderContactPage({ sent: true }));

    if (isLimited(clientIp(req))) {
      return res.status(429).send(renderContactPage({ error: 'Too many messages from this connection — please try again later.', values: req.body }));
    }

    const { error, values } = validateContact(req.body);
    if (error) return res.status(400).send(renderContactPage({ error, values }));

    // Log before sending: the file is the record, email is the notification.
    const receivedAt = new Date().toISOString();
    try {
      fs.appendFileSync(logFile, JSON.stringify({ receivedAt, ...values }) + '\n');
    } catch (e) {
      console.error('Failed to log contact message:', e);
    }

    try {
      await sendEmail(values);
    } catch (e) {
      // Already on disk, so the visitor still gets a success page. The
      // failure is logged as its own line so the admin view can flag it.
      console.error('Failed to email contact message:', e.message);
      try {
        fs.appendFileSync(logFile, JSON.stringify({ receivedAt, emailFailed: e.message }) + '\n');
      } catch {}
    }

    res.send(renderContactPage({ sent: true }));
  });

  // Gated by app.use('/api/admin', requireAdminKey) in server.js.
  router.get('/api/admin/contact-messages', (req, res) => {
    const lines = readContactLog(logFile);
    const failures = new Map(lines.filter(e => e.emailFailed).map(e => [e.receivedAt, e.emailFailed]));
    res.json(lines
      .filter(e => e.message)
      .map(e => failures.has(e.receivedAt) ? { ...e, emailFailed: failures.get(e.receivedAt) } : e)
      .reverse());
  });

  return router;
}
