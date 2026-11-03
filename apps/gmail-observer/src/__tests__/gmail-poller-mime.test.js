import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmailPoller } from '../gmail-poller.js';

// Reuse an existing parser fixture: these tests exercise Gmail's MIME structure,
// not a new bank notification format or payment attribution rule.
const alertText = 'Dear customer, Rs 150.00 credited to your account. UTR: 778899001122';
const alertHtml = `<p>${alertText}</p>`;
const snippet = 'Dear customer, please see the account update below.';
const part = (mimeType, text) => ({
  mimeType,
  body: { data: Buffer.from(text).toString('base64url') }
});

async function observePayload(t, payload, messageSnippet = snippet) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-gmail-mime-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const poller = new GmailPoller({
    receivingAccountId: 'mime-test-account',
    storagePath: path.join(storageDir, 'processed.json')
  });
  t.mock.method(poller, 'getAccessToken', async () => 'synthetic-access-token');
  const submitted = [];
  t.mock.method(poller.observerClient, 'submitObservation', async observation => {
    submitted.push(observation);
    return { accepted: true };
  });
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    if (url.pathname === '/gmail/v1/users/me/messages') {
      return Response.json({ messages: [{ id: 'mime-message' }] });
    }
    assert.equal(url.pathname, '/gmail/v1/users/me/messages/mime-message');
    assert.equal(url.searchParams.get('format'), 'full');
    return Response.json({
      internalDate: String(Date.now()),
      snippet: messageSnippet,
      payload: {
        ...payload,
        headers: [
          { name: 'From', value: 'alerts@hdfcbank.net' },
          { name: 'Subject', value: 'Credit alert' }
        ]
      }
    });
  });

  await poller.pollCycle();
  assert.equal(submitted.length, 1, 'the complete alert should reach the observer client');
  assert.equal(submitted[0].amountPaise, 15000n);
  assert.equal(submitted[0].bankReferenceNumber, '778899001122');
  assert.ok(poller.processedMessageIds.has('mime-message'));
  return submitted[0].rawPayload.body;
}

// Gmail MessagePart.parts recursively contains child MIME parts:
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#MessagePart
test('pollCycle reads plain text inside nested multipart containers', async t => {
  const body = await observePayload(t, {
    mimeType: 'multipart/mixed',
    parts: [{
      mimeType: 'multipart/alternative',
      parts: [part('text/html', alertHtml), part('text/plain', alertText)]
    }]
  });
  assert.equal(body, alertText);
});

test('pollCycle prefers nested plain text over shallower HTML in another branch', async t => {
  const body = await observePayload(t, {
    mimeType: 'multipart/mixed',
    parts: [
      part('text/html', '<p>Dear customer, please see the account update below.</p>'),
      { mimeType: 'multipart/related', parts: [{
        mimeType: 'multipart/alternative', parts: [part('text/plain', alertText)]
      }] }
    ]
  });
  assert.equal(body, alertText);
});

test('pollCycle falls back to nested HTML when no plain text is present', async t => {
  const body = await observePayload(t, {
    mimeType: 'multipart/related',
    parts: [{ mimeType: 'multipart/alternative', parts: [part('text/html', alertHtml)] }]
  });
  assert.equal(body.trim(), alertText);
  assert.ok(!body.includes('<p>'));
});

test('pollCycle keeps reading a top-level plain-text message', async t => {
  assert.equal(await observePayload(t, part('text/plain', alertText)), alertText);
});

test('pollCycle keeps preferring plain text in a flat multipart alternative', async t => {
  assert.equal(await observePayload(t, {
    mimeType: 'multipart/alternative',
    parts: [part('text/html', alertHtml), part('text/plain', alertText)]
  }), alertText);
});

test('pollCycle preserves the snippet fallback for empty MIME bodies', async t => {
  assert.equal(await observePayload(t, {
    mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: {} }]
  }, alertText), alertText);
});

test('pollCycle preserves the untyped top-level body fallback', async t => {
  assert.equal(await observePayload(t, { body: part('text/plain', alertText).body }), alertText);
});

test('pollCycle preserves the untyped direct-part body fallback', async t => {
  assert.equal(await observePayload(t, { parts: [{ body: part('text/plain', alertText).body }] }), alertText);
});

test('pollCycle does not treat a nested binary attachment as the message body', async t => {
  assert.equal(await observePayload(t, {
    mimeType: 'multipart/mixed', parts: [{
      mimeType: 'multipart/related', parts: [part('application/octet-stream', 'binary attachment')]
    }]
  }, alertText), alertText);
});

for (const [name, attachment] of [
  ['an attached message', { mimeType: 'message/rfc822', parts: [part('text/plain', 'attached message')] }],
  ['a named multipart attachment', { mimeType: 'multipart/alternative', filename: 'alert.eml', parts: [part('text/plain', 'attached text')] }],
  ['an attachment disposition', { mimeType: 'multipart/alternative', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="alert.eml"' }], parts: [part('text/plain', 'attached text')] }],
  ['a named nested text attachment', { mimeType: 'multipart/related', parts: [{ ...part('text/plain', 'attached text'), filename: 'alert.txt' }] }]
]) {
  test(`pollCycle does not expand body extraction into ${name}`, async t => {
    assert.equal(await observePayload(t, {
      mimeType: 'multipart/mixed', parts: [attachment]
    }, alertText), alertText);
  });
}
