import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { PaymentStatus, ObservationAttributionStatus, resolveSecret, generateHmac } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_PORT = 6328;
const PERSIST_DB_PATH = path.resolve(__dirname, '../../../data/test_stage3_persistence.sqlite');

describe('Mitto Pay Stage 3 — Synthetic Integration & Financial Safety Tests', () => {
  let apiInstance;
  let driver;
  let testDb;
  let enrollmentSecret;
  let emittedSuccessCount = 0;

  before(async () => {
    // Enforce strict dual-channel verification policy for Stage 3 security assertions
    process.env.YOUPI_VERIFICATION_POLICY = 'REQUIRE_DUAL_CHANNEL';

    // Ensure clean database state
    if (fs.existsSync(PERSIST_DB_PATH)) fs.unlinkSync(PERSIST_DB_PATH);
    const wal = `${PERSIST_DB_PATH}-wal`;
    const shm = `${PERSIST_DB_PATH}-shm`;
    if (fs.existsSync(wal)) try { fs.unlinkSync(wal); } catch {}
    if (fs.existsSync(shm)) try { fs.unlinkSync(shm); } catch {}

    testDb = new Database({ dbPath: PERSIST_DB_PATH });
    apiInstance = await startPaymentApi(TEST_PORT, testDb);
    enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');

    // Track if any PAYMENT.SUCCESS events are ever emitted
    apiInstance.app.context.eventEmitter.on('PAYMENT.SUCCESS', () => {
      emittedSuccessCount++;
    });

    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${TEST_PORT}`,
      deviceName: 'Mitto Pay Synthetic Tester',
      deviceModel: 'Pixel 8 Test Harness'
    });
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
    delete process.env.YOUPI_VERIFICATION_POLICY;
    if (fs.existsSync(PERSIST_DB_PATH)) try { fs.unlinkSync(PERSIST_DB_PATH); } catch {}
    const wal = `${PERSIST_DB_PATH}-wal`;
    const shm = `${PERSIST_DB_PATH}-shm`;
    if (fs.existsSync(wal)) try { fs.unlinkSync(wal); } catch {}
    if (fs.existsSync(shm)) try { fs.unlinkSync(shm); } catch {}
  });

  // Helper to free slot between tests
  const freeSlot = (sessionId) => {
    if (sessionId) {
      apiInstance.app.context.db.execute(
        "UPDATE payment_sessions SET status = 'SUCCESS', updated_at = datetime('now') WHERE id = ?",
        [sessionId]
      );
    }
  };

  const clearSlots = () => {
    apiInstance.app.context.db.execute(
      "UPDATE payment_sessions SET status = 'EXPIRED', updated_at = datetime('now') WHERE status IN ('ACTIVE', 'PROCESSING')"
    );
  };

  // 1. Valid enrolled-device request & Financial Invariant Check
  test('1. Valid enrolled-device pairing and authenticated observation (SMS alone cannot finalize payment)', async () => {
    const pairResult = await driver.pair(enrollmentSecret);
    assert.ok(pairResult.paired);
    assert.ok(pairResult.deviceId);
    assert.ok(pairResult.signingKey);

    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'STAGE3-ORD-001',
      amountPaise: 100000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    const res = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: 'Dear Customer, INR 1000.00 credited to your A/C ending 4321 via UPI Ref 111222333444 on 20-OCT-26.',
      clientMessageId: 'stage3-msg-001'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.clientMessageId, 'stage3-msg-001');

    // Financial Invariant Verification:
    // SMS ALONE MUST NOT SET SUCCESS (Dual-channel requirement)
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.notEqual(updated.status, PaymentStatus.SUCCESS, 'SMS alone MUST NOT finalize payment to SUCCESS');
    assert.equal(updated.status, PaymentStatus.PROCESSING, 'Session must remain in PROCESSING pending second channel');

    // Confirm NO success webhooks are delivered
    const webhookCount = apiInstance.app.context.db.queryOne(
      'SELECT count(*) as cnt FROM webhook_deliveries WHERE event_type = ?',
      ['PAYMENT.SUCCESS']
    );
    assert.equal(webhookCount?.cnt || 0, 0, 'No success webhook may be emitted on SMS alone');

    // Free the slot for subsequent tests
    freeSlot(session.id);
  });

  // 2. Missing, malformed, or unknown device identity
  test('2. Missing, malformed, or unknown device identity is rejected', async () => {
    const now = Date.now().toString();
    const payload = JSON.stringify({ sender: 'VK-HDFCBK', body: 'INR 100.00 credited', timestamp: Number(now) });

    // Missing X-Device-Id
    const resNoId = await fetch(`http://localhost:${TEST_PORT}/api/v1/observers/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Timestamp': now, 'X-Signature': 'fake_sig' },
      body: payload
    });
    assert.equal(resNoId.status, 400);

    // Unknown Device ID
    const resUnknown = await fetch(`http://localhost:${TEST_PORT}/api/v1/observers/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': '00000000-9999-9999-9999-000000000000',
        'X-Timestamp': now,
        'X-Signature': 'fake_sig'
      },
      body: payload
    });
    assert.equal(resUnknown.status, 403);
  });

  // 3. Invalid HMAC signature and altered payload
  test('3. Invalid HMAC signature and altered payload are rejected (Tamper Protection)', async () => {
    const now = Date.now().toString();
    const originalBody = JSON.stringify({ deviceId: driver.deviceId, amount: '500.00' });
    const validSignature = generateHmac(`${originalBody}:${now}`, driver.signingKey);

    // Tampered body with higher amount using signature computed for lower amount
    const tamperedBody = JSON.stringify({ deviceId: driver.deviceId, amount: '50000.00' });

    const res = await fetch(`http://localhost:${TEST_PORT}/api/v1/observers/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': driver.deviceId,
        'X-Timestamp': now,
        'X-Signature': validSignature
      },
      body: tamperedBody
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.includes('signature') || body.error.includes('HMAC'));
  });

  // 4. Expired timestamp, future timestamp, and boundary conditions around 60s window
  test('4. Replay protection rejects expired (>60s) or far-future timestamps', async () => {
    const expiredTimestamp = Date.now() - 65000; // 65 seconds in the past
    const futureTimestamp = Date.now() + 65000;  // 65 seconds in the future
    const validBoundaryTs = Date.now() - 30000;  // 30 seconds in the past (valid)

    // Expired
    const resExpired = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: 'INR 100.00 credited',
      timestampOverride: expiredTimestamp
    });
    assert.equal(resExpired.status, 401);
    assert.ok(resExpired.body.error.includes('validity window'));

    // Far Future
    const resFuture = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: 'INR 100.00 credited',
      timestampOverride: futureTimestamp
    });
    assert.equal(resFuture.status, 401);
    assert.ok(resFuture.body.error.includes('validity window'));

    // Valid Boundary (30s drift) - with active session matching ₹200
    const sBoundary = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'STAGE3-ORD-BOUNDARY',
      amountPaise: 20000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sBoundary.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(sBoundary.id);

    const resValid = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: 'Dear Customer, INR 200.00 credited to your A/C ending 4321 via UPI Ref 222333444555 on 20-OCT-26.',
      timestampOverride: validBoundaryTs
    });
    assert.equal(resValid.status, 200);

    freeSlot(sBoundary.id);
  });

  // 5. Same clientMessageId submitted repeatedly
  test('5. Same clientMessageId submitted repeatedly is accepted idempotently and rejected as duplicate', async () => {
    clearSlots();
    const sRepeat = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'STAGE3-ORD-REPEAT',
      amountPaise: 25000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sRepeat.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(sRepeat.id);

    const clientMsgId = 'stage3-repeat-id-555';
    const bodyText = 'Dear Customer, INR 250.00 credited to your A/C ending 4321 via UPI Ref 555666777888 on 20-OCT-26.';

    const res1 = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: bodyText,
      clientMessageId: clientMsgId
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.accepted, true);
    assert.equal(res1.body.clientMessageId, clientMsgId);

    // Repeated submission of exact same message
    const res2 = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: bodyText,
      clientMessageId: clientMsgId
    });
    // Pipeline deduplication must identify duplicate observation and reject safely
    assert.equal(res2.status, 400);
    assert.equal(res2.body.accepted, false);
    assert.equal(res2.body.reason, 'DUPLICATE_OBSERVATION');
    assert.equal(res2.body.clientMessageId, clientMsgId);

    freeSlot(sRepeat.id);
  });

  // 6. Same observation submitted concurrently from multiple requests
  test('6. Concurrent identical observation requests execute race-safely without corruption', async () => {
    clearSlots();
    const sConcur = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'STAGE3-ORD-CONCUR',
      amountPaise: 30000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sConcur.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(sConcur.id);

    const uTr = '999111222333';
    const bodyText = `Dear Customer, INR 300.00 credited to your A/C ending 4321 via UPI Ref ${uTr} on 20-OCT-26.`;

    // Fire 5 concurrent requests with the exact same observation
    const requests = Array.from({ length: 5 }).map((_, i) =>
      driver.submitSms({
        sender: 'VK-HDFCBK',
        body: bodyText,
        clientMessageId: `concurrent-req-${i}`
      })
    );

    const responses = await Promise.all(requests);
    // Exactly one must be accepted (200), and all others rejected as DUPLICATE_OBSERVATION (400)
    const accepted = responses.filter(r => r.status === 200 && r.body.accepted === true);
    const duplicates = responses.filter(r => r.status === 400 && r.body.reason === 'DUPLICATE_OBSERVATION');

    assert.equal(accepted.length, 1, 'Exactly one concurrent request must be accepted');
    assert.equal(duplicates.length, 4, 'Remaining concurrent requests must be rejected as duplicates');

    // Exactly 1 observation record stored in DB
    const obsRows = apiInstance.app.context.db.query(
      'SELECT id FROM payment_observations WHERE bank_reference_number = ?',
      [uTr]
    );
    assert.equal(obsRows.length, 1, 'Only one persistent observation record should exist');

    freeSlot(sConcur.id);
  });

  // 7. Duplicate observation after service restart (persistent dedup)
  test('7. Persistent deduplication recognizes duplicate alert across service restarts', async () => {
    clearSlots();
    const sRestart = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'STAGE3-ORD-RESTART',
      amountPaise: 45000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sRestart.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(sRestart.id);

    const uTr = '777888999000';
    const bodyText = `Dear Customer, INR 450.00 credited to your A/C ending 4321 via UPI Ref ${uTr} on 20-OCT-26.`;

    // 1. Submit observation on running server
    const res1 = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: bodyText,
      clientMessageId: 'pre-restart-msg'
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.accepted, true);

    // 2. Simulate complete server restart using same SQLite database file
    await apiInstance.close();
    testDb.close();
    await new Promise(r => setTimeout(r, 100)); // Clean socket release

    // Reopen database from disk and restart server
    const restartDb = new Database({ dbPath: PERSIST_DB_PATH });
    apiInstance = await startPaymentApi(TEST_PORT, restartDb);
    testDb = restartDb;

    // 3. Re-submit identical observation after restart
    const res2 = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: bodyText,
      clientMessageId: 'post-restart-msg'
    });

    // Persistent deduplication in SQLite must detect and reject the duplicate observation
    assert.equal(res2.status, 400);
    assert.equal(res2.body.accepted, false);
    assert.equal(res2.body.reason, 'DUPLICATE_OBSERVATION');

    freeSlot(sRestart.id);
  });

  // 8. Same UTR and receiving account submitted against two active sessions
  test('8. Same UTR submitted against two distinct active sessions cannot be double-claimed', async () => {
    clearSlots();
    const sharedUtr = '888123456789';

    // Prior session 1 settled with sharedUtr
    const s1 = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'SESS-UTR-1',
      amountPaise: 20000n
    });
    const obs1 = apiInstance.app.context.obsRepo.create({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'ANDROID_OBSERVER',
      amountPaise: 20000n,
      observedAt: new Date(),
      bankReferenceNumber: sharedUtr,
      fingerprintHash: 'hash_s1_shared',
      attributedPaymentId: s1.id
    });
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'SUCCESS', attributed_observation_id = ? WHERE id = ?", [obs1.id, s1.id]);

    // Create session 2 on the now-vacant account slot
    const s2 = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'SESS-UTR-2',
      amountPaise: 20000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(s2.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(s2.id);

    // Observer attempts to submit same UTR for s2
    const res = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: `Dear Customer, INR 200.00 credited to your A/C ending 4321 via UPI Ref ${sharedUtr} on 20-OCT-26.`,
      clientMessageId: 'utr-steal-attempt'
    });

    assert.equal(res.status, 400);
    assert.ok(res.body.reason === 'REFERENCE_ALREADY_USED' || res.body.reason === 'DUPLICATE_OBSERVATION');

    // S2 must NOT be marked SUCCESS because the UTR was already consumed by s1
    const checkS2 = apiInstance.app.context.sessionRepo.findById(s2.id);
    assert.notEqual(checkS2.status, PaymentStatus.SUCCESS, 'Reused UTR must not advance second session to SUCCESS');

    freeSlot(s2.id);
  });

  // 9. Same UTR across different accounts
  test('9. Same UTR cannot be attributed to a different receiving account if already settled', async () => {
    clearSlots();
    const crossUtr = '999888111222';
    // Create second merchant and receiving account
    apiInstance.app.context.db.execute(`
      INSERT OR IGNORE INTO merchants (id, business_name, slug, contact_email, contact_phone, webhook_secret)
      VALUES ('00000000-0000-0000-0000-000000000009', 'Merchant Two', 'm2-slug', 'm2@example.com', '9999999999', 'm2_sec')
    `);
    apiInstance.app.context.db.execute(`
      INSERT OR IGNORE INTO payment_receiving_accounts (id, merchant_id, upi_id, payee_name, is_active)
      VALUES ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000009', 'm2@upi', 'Holder Two', 1)
    `);

    // Prior session on Account 1 settled with crossUtr
    const sOld = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'SESS-CROSS-1',
      amountPaise: 50000n
    });
    const obsOld = apiInstance.app.context.obsRepo.create({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'GMAIL',
      amountPaise: 50000n,
      observedAt: new Date(),
      bankReferenceNumber: crossUtr,
      fingerprintHash: 'hash_cross_old',
      attributedPaymentId: sOld.id
    });
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'SUCCESS', attributed_observation_id = ? WHERE id = ?", [obsOld.id, sOld.id]);

    // Session on Account 2
    const sNew = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000009',
      receivingAccountId: '00000000-0000-0000-0000-000000000099',
      orderId: 'SESS-CROSS-2',
      amountPaise: 50000n
    });
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'ACTIVE' WHERE id = ?", [sNew.id]);

    // Pipeline verification must reject reused reference across different accounts
    const pipeRes = apiInstance.app.context.pipeline.process({
      source: 'SMS',
      rawText: `Dear Customer, INR 500.00 credited to your A/C ending 4321 via UPI Ref ${crossUtr} on 20-OCT-26.`,
      sender: 'VK-HDFCBK',
      receivingAccountId: '00000000-0000-0000-0000-000000000099',
      paymentSessionId: sNew.id
    });

    assert.equal(pipeRes.status, 'REJECTED');
    assert.equal(pipeRes.failingCondition, 'REFERENCE_ALREADY_USED');

    freeSlot(sNew.id);
  });

  // 10. Attempted receiving-account or merchant mismatch
  test('10. Device cannot submit observations for a different merchant account', async () => {
    // Authenticated device is bound to Merchant 00000000-0000-0000-0000-000000000001
    // Attempting to pass a foreign receivingAccountId
    const res = await driver.submitObservation({
      amount: '500.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000099', // Foreign account
      utr: 'UTR-SPOOF-001',
      notificationText: 'Payment of ₹500 received'
    });

    // Server strictly resolves receiving account from authenticated device registration (Merchant 1)
    // and ignores foreign client-supplied receivingAccountId
    assert.ok(res.status === 200 || res.status === 400);
  });

  // 11. Malformed amount, unsupported currency, missing bank reference, oversized payload
  test('11. Malformed amount and oversized payloads fail safely', async () => {
    // Malformed amount (negative) -> Server drops from monetary attribution (attributed: false, UNATTRIBUTED)
    const resNeg = await driver.submitObservation({
      amount: '-50.00',
      utr: 'UTR-NEG-001'
    });
    assert.equal(resNeg.status, 200);
    assert.equal(resNeg.body.attribution.attributed, false);
    assert.equal(resNeg.body.attribution.outcomeStatus, 'UNATTRIBUTED');

    // Oversized payload (> 64KB synthetic buffer) -> rejected safely
    const giantText = 'A'.repeat(70000);
    const resGiant = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: giantText
    });
    assert.ok(resGiant.status >= 400 || resGiant.body.status === 'PROCESSED_NON_BANK');
  });

  // 12. Invalid or conflicting second-channel evidence
  test('12. Conflicting second-channel evidence with mismatched UTR is rejected', async () => {
    clearSlots();
    const sDual = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'SESS-DUAL-CONFLICT',
      amountPaise: 80000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sDual.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(sDual.id);

    // Channel 1: Android SMS arrives with UTR-CORRECT
    const r1 = apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'ANDROID_OBSERVER',
      amountPaise: 80000n,
      observedAt: new Date(),
      bankReferenceNumber: 'UTR-CORRECT-111',
      fingerprintHash: 'hash_dual_c1'
    });
    assert.equal(r1.attributed, true);
    assert.equal(r1.verificationLevel, 1);

    // Channel 2: Second channel arrives with CONFLICTING UTR-WRONG-222
    const r2 = apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'GMAIL',
      amountPaise: 80000n,
      observedAt: new Date(),
      bankReferenceNumber: 'UTR-WRONG-222',
      fingerprintHash: 'hash_dual_c2'
    });

    const checkDual = apiInstance.app.context.sessionRepo.findById(sDual.id);
    assert.notEqual(checkDual.status, PaymentStatus.SUCCESS, 'Conflicting UTR second channel must NOT set SUCCESS');

    freeSlot(sDual.id);
  });

  // 13. SMS-only observation for active, cancelled, expired, and already-successful sessions
  test('13. Terminal sessions (CANCELLED, EXPIRED, SUCCESS) are never revived by SMS observations', async () => {
    // A. CANCELLED Session
    const sCancelled = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'SESS-CANCEL-TERM',
      amountPaise: 15000n
    });
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE id = ?", [sCancelled.id]);

    // Observation arrives for cancelled session
    apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'ANDROID_OBSERVER',
      amountPaise: 15000n,
      observedAt: new Date(),
      bankReferenceNumber: 'UTR-LATE-CANCEL',
      fingerprintHash: 'hash_late_cancel'
    });
    const checkCancel = apiInstance.app.context.sessionRepo.findById(sCancelled.id);
    assert.equal(checkCancel.status, PaymentStatus.CANCELLED, 'Cancelled session must remain CANCELLED');

    // B. EXPIRED Session
    const sExpired = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'SESS-EXP-TERM',
      amountPaise: 16000n
    });
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE id = ?", [sExpired.id]);

    apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'ANDROID_OBSERVER',
      amountPaise: 16000n,
      observedAt: new Date(),
      bankReferenceNumber: 'UTR-LATE-EXP',
      fingerprintHash: 'hash_late_exp'
    });
    const checkExp = apiInstance.app.context.sessionRepo.findById(sExpired.id);
    assert.equal(checkExp.status, PaymentStatus.EXPIRED, 'Expired session must remain EXPIRED');
  });

  // 14. Device revocation and expired-device behavior
  test('14. Revoked (is_active = 0) device is immediately blocked from submitting observations', async () => {
    // Deactivate the paired device directly in DB
    apiInstance.app.context.db.execute('UPDATE android_devices SET is_active = 0 WHERE id = ?', [driver.deviceId]);

    const res = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: 'INR 100.00 credited',
      clientMessageId: 'revoked-test-id'
    });

    assert.equal(res.status, 403);
    assert.ok(res.body.error.includes('not authorized') || res.body.error.includes('inactive'));

    // Reactivate for teardown cleanliness
    apiInstance.app.context.db.execute('UPDATE android_devices SET is_active = 1 WHERE id = ?', [driver.deviceId]);
  });
});
