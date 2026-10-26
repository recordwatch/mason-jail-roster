import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateContact, createRateLimiter, renderContactPage, readContactLog, createContactRouter } from '../routes/contact.js';

async function withServer(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-'));
  const logFile = path.join(dir, 'contact.jsonl');
  const app = express();
  app.use(createContactRouter({ logFile, ...opts }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = fields => fetch(`${base}/contact`, { method: 'POST', body: new URLSearchParams(fields) });
  try {
    await fn({ base, post, logFile });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('validateContact requires a message; name and email are optional', () => {
  assert.equal(validateContact({ message: 'Hello there, a question.' }).error, undefined);
  assert.match(validateContact({ message: 'hi' }).error, /message/);
  assert.match(validateContact({ message: 'Hello there, a question.', email: 'nope' }).error, /email/);
  assert.match(validateContact({ message: 'x'.repeat(5001) }).error, /5,000/);
  assert.deepEqual(validateContact({ name: '  Pat ', message: '  long enough message ' }).values,
    { name: 'Pat', email: '', message: 'long enough message' });
});

test('rate limiter allows max hits per window, then resets', () => {
  const isLimited = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(isLimited('a', 0), false);
  assert.equal(isLimited('a', 1), false);
  assert.equal(isLimited('a', 2), true);
  assert.equal(isLimited('b', 2), false);
  assert.equal(isLimited('a', 1001), false);
});

test('contact page escapes re-rendered input', () => {
  const html = renderContactPage({ error: 'x', values: { message: '</textarea><script>alert(1)</script>' } });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;/textarea&gt;'));
});

test('valid submission is logged and emailed', async () => {
  const sent = [];
  await withServer({ sendEmail: async v => { sent.push(v); } }, async ({ post, logFile }) => {
    const res = await post({ name: 'Pat', email: 'pat@example.com', message: 'Please add Yakima County.' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message was received/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, 'pat@example.com');
    const log = readContactLog(logFile);
    assert.equal(log.length, 1);
    assert.equal(log[0].message, 'Please add Yakima County.');
    assert.ok(log[0].receivedAt);
  });
});

test('email failure still keeps the message and flags it in the admin view', async () => {
  await withServer({ sendEmail: async () => { throw new Error('boom'); } }, async ({ base, post }) => {
    const res = await post({ message: 'Message that fails to email.' });
    assert.equal(res.status, 200);
    const msgs = await (await fetch(`${base}/api/admin/contact-messages`)).json();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].message, 'Message that fails to email.');
    assert.equal(msgs[0].emailFailed, 'boom');
  });
});

test('honeypot submissions get a success page but are neither logged nor sent', async () => {
  let calls = 0;
  await withServer({ sendEmail: async () => { calls++; } }, async ({ post, logFile }) => {
    const res = await post({ message: 'Buy cheap things now!!', website: 'http://spam.example' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message was received/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(logFile), false);
  });
});

test('invalid submission re-renders the form with an error and keeps input', async () => {
  await withServer({ sendEmail: async () => {} }, async ({ post, logFile }) => {
    const res = await post({ name: 'Pat', message: 'hi' });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /at least a few words/);
    assert.match(html, /value="Pat"/);
    assert.equal(fs.existsSync(logFile), false);
  });
});

test('over the rate limit returns 429', async () => {
  const isLimited = createRateLimiter({ windowMs: 60000, max: 1 });
  await withServer({ sendEmail: async () => {}, isLimited }, async ({ post }) => {
    assert.equal((await post({ message: 'First message here.' })).status, 200);
    assert.equal((await post({ message: 'Second message here.' })).status, 429);
  });
});
