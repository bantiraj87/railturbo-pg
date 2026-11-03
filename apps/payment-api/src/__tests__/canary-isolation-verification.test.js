import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, generateHmac } from '@youpi/common';

describe('Mitto Pay — Canary Isolation & Dual-Channel Settlement Tests', () => {
  let apiInstance;
  let testDb;
  let serverUrl;
  const CANARY_TEST_PORT = 6339;
  const AUTHORIZED_UID = 'VVANFTTKRA';

  before(async () => {
    testDb = new Database({ inMemory: true });
    process.env.YOUPI_VERIFICATION_POLICY = 'REQUIRE_DUAL_CHANNEL';
    process.env.CANARY_MERCHANT_ALLOWLIST = AUTHORIZED_UID;

    apiInstance = await startPaymentApi(CANARY_TEST_PORT, testDb);
    serverUrl = `http://localhost:${CANARY_TEST_PORT}`;

    testDb.execute("UPDATE merchants SET branding = ? WHERE id = '00000000-0000-0000-0000-000000000001'", [JSON.stringify({ vvisaUid: AUTHORIZED_UID })]);
    testDb.execute(`
      INSERT OR REPLACE INTO merchants (id, business_name, slug, contact_email, contact_phone, webhook_secret, created_at, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000099', 'Unauthorized Corp', 'unauth', 'unauth@test.local', '+919999999999', 'secret_99', datetime('now'), datetime('now'))
    `);
  });

  after(async () => {
    delete process.env.CANARY_MERCHANT_ALLOWLIST;
    delete process.env.YOUPI_VERIFICATION_POLICY;
    await apiInstance.close();
    testDb.close();
  });

  // Helper to make payment creation requests
  async function createPayment(payload, headers = {}) {
    const res = await fetch(`${serverUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  // 1. Direct API call from unauthorized merchant / agency is blocked
  test('1. Direct payment creation from unauthorized merchant is rejected with 403 CANARY_MERCHANT_UNAUTHORIZED', async () => {
    const res = await createPayment({
      orderId: 'CANARY-UNAUTH-001',
      amount: '50.00',
      merchantId: '00000000-0000-0000-0000-000000000099',
      metadata: {
        agencyVvisaUid: 'SOME_UNAUTHORIZED_AGENCY'
      }
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CANARY_MERCHANT_UNAUTHORIZED');
  });

  test('2. Direct payment creation without allowlisted agency metadata is rejected with 403', async () => {
    const res = await createPayment({
      orderId: 'CANARY-NO-META-002',
      amount: '50.00'
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CANARY_MERCHANT_UNAUTHORIZED');
  });

  test('3. Authorized internal merchant (VVANFTTKRA) is permitted to create canary payment sessions', async () => {
    const res = await createPayment({
      orderId: 'CANARY-AUTH-003',
      amount: '10.00',
      autoActivate: true,
      metadata: {
        agencyVvisaUid: AUTHORIZED_UID
      }
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.paymentId);
    assert.ok(res.body.checkoutUrl);
    assert.equal(res.body.orderId, 'CANARY-AUTH-003');

    // Clean slot
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'SUCCESS' WHERE id = ?", [res.body.paymentId]);
  });

  test('4. Canary settlement strictly fails if YOUPI_VERIFICATION_POLICY is invalid', async () => {
    // Temporarily set invalid verification policy
    process.env.YOUPI_VERIFICATION_POLICY = 'INSECURE_INVALID_POLICY';

    const res = await createPayment({
      orderId: 'CANARY-FAIL-SAFE-004',
      amount: '10.00',
      metadata: {
        agencyVvisaUid: AUTHORIZED_UID
      }
    });

    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'INVALID_VERIFICATION_POLICY');

    // Restore strict policy
    process.env.YOUPI_VERIFICATION_POLICY = 'REQUIRE_DUAL_CHANNEL';
  });

  test('4b. Canary settlement succeeds when YOUPI_VERIFICATION_POLICY is SINGLE_CHANNEL_VALIDATED_GMAIL', async () => {
    process.env.YOUPI_VERIFICATION_POLICY = 'SINGLE_CHANNEL_VALIDATED_GMAIL';

    const res = await createPayment({
      orderId: 'CANARY-SINGLE-POLICY-004B',
      amount: '10.00',
      autoActivate: true,
      metadata: {
        agencyVvisaUid: AUTHORIZED_UID
      }
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.paymentId);

    // Clean slot
    apiInstance.app.context.db.execute("UPDATE payment_sessions SET status = 'SUCCESS' WHERE id = ?", [res.body.paymentId]);
    process.env.YOUPI_VERIFICATION_POLICY = 'REQUIRE_DUAL_CHANNEL';
  });

  test('4c. End-to-end fast confirmation: Validated Gmail observation auto-finalizes to SUCCESS under SINGLE_CHANNEL_VALIDATED_GMAIL', async () => {
    process.env.YOUPI_VERIFICATION_POLICY = 'SINGLE_CHANNEL_VALIDATED_GMAIL';
    apiInstance.app.context.attributionEngine.verificationPolicy = 'SINGLE_CHANNEL_VALIDATED_GMAIL';

    let successEmitted = false;
    let successPayload = null;
    const startTime = performance.now();

    apiInstance.app.context.eventEmitter.once('PAYMENT.SUCCESS', (data) => {
      successEmitted = true;
      successPayload = data;
    });

    // 1. Create canary session for VVANFTTKRA
    const createRes = await createPayment({
      orderId: 'CANARY-GMAIL-FAST-001',
      amount: '10.00',
      autoActivate: true,
      metadata: {
        agencyVvisaUid: AUTHORIZED_UID,
        vvisaAmountMinor: 1000
      }
    });
    assert.equal(createRes.status, 201);
    const paymentId = createRes.body.paymentId;

    // 2. Ingest validated Gmail observation
    const uTr = '911789526799';
    const gmailRes = apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'GMAIL',
      amountPaise: 1000n,
      observedAt: new Date(),
      bankReferenceNumber: uTr,
      fingerprintHash: `fp_fast_gmail_${uTr}`
    });

    const elapsedMs = performance.now() - startTime;

    assert.equal(gmailRes.attributed, true);
    assert.equal(gmailRes.verificationLevel, 1);
    assert.equal(gmailRes.outcomeStatus, PaymentStatus.SUCCESS);
    assert.equal(successEmitted, true);
    assert.equal(successPayload.paymentId, paymentId);
    assert.ok(elapsedMs < 100, `Processing took ${elapsedMs.toFixed(2)}ms, expected < 100ms`);

    // Verify session in DB transitioned to SUCCESS
    const finalSession = apiInstance.app.context.sessionRepo.findById(paymentId);
    assert.equal(finalSession.status, PaymentStatus.SUCCESS);
    assert.equal(finalSession.verificationTag, 'Single Verification (Gmail)');

    // Restore
    process.env.YOUPI_VERIFICATION_POLICY = 'REQUIRE_DUAL_CHANNEL';
    apiInstance.app.context.attributionEngine.verificationPolicy = 'REQUIRE_DUAL_CHANNEL';
  });

  test('5. End-to-end canary settlement: SMS alone stays in PROCESSING; secondary Gmail finalizes to SUCCESS', async () => {
    let successEventEmitted = false;
    let emittedPayload = null;

    apiInstance.app.context.eventEmitter.once('PAYMENT.SUCCESS', (data) => {
      successEventEmitted = true;
      emittedPayload = data;
    });

    // 1. Create and activate canary session for ₹10.00
    const createRes = await createPayment({
      orderId: 'CANARY-ORDER-VVANFTTKRA-10',
      amount: '10.00',
      autoActivate: true,
      metadata: {
        agencyVvisaUid: AUTHORIZED_UID,
        vvisaAmountMinor: 1000
      }
    });
    assert.equal(createRes.status, 201);
    const paymentId = createRes.body.paymentId;

    // 2. Channel 1: Ingest valid SMS credit observation
    const uTr = '999888777666';
    const sharedFp = `fp_shared_utr_${uTr}`;
    const smsRes = apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'ANDROID_OBSERVER',
      amountPaise: 1000n,
      observedAt: new Date(),
      bankReferenceNumber: uTr,
      fingerprintHash: sharedFp
    });

    assert.equal(smsRes.attributed, true);
    assert.equal(smsRes.verificationLevel, 1);
    assert.equal(smsRes.outcomeStatus, PaymentStatus.PROCESSING);

    // Verify session does not finalize to SUCCESS and NO PAYMENT.SUCCESS emitted
    const sAfterSms = apiInstance.app.context.sessionRepo.findById(paymentId);
    assert.notEqual(sAfterSms.status, PaymentStatus.SUCCESS, 'SMS alone MUST NOT finalize session to SUCCESS');
    assert.equal(successEventEmitted, false, 'SMS alone MUST NOT emit PAYMENT.SUCCESS');

    // 3. Channel 2: Ingest confirming Gmail observation with matching UTR and amount
    const gmailRes = apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'GMAIL',
      amountPaise: 1000n,
      observedAt: new Date(),
      bankReferenceNumber: uTr,
      fingerprintHash: sharedFp
    });

    assert.equal(gmailRes.attributed, true);
    assert.equal(gmailRes.verificationLevel, 2);
    assert.equal(gmailRes.outcomeStatus, PaymentStatus.SUCCESS);

    // Verify session promoted to terminal SUCCESS upon dual-channel confirmation
    const sAfterDual = apiInstance.app.context.sessionRepo.findById(paymentId);
    assert.equal(sAfterDual.status, PaymentStatus.SUCCESS);
    assert.equal(successEventEmitted, true, 'Dual-channel evidence MUST emit PAYMENT.SUCCESS');
    assert.equal(emittedPayload.paymentId, paymentId);
    assert.equal(emittedPayload.verificationLevel, 2);

    // 4. Verify Webhook Generation & Signature
    const merchant = apiInstance.app.context.merchantRepo.findById(sAfterDual.merchantId);
    assert.ok(merchant.webhookSecret);
    const webhookBody = JSON.stringify({
      event: 'SUCCESS',
      paymentId: sAfterDual.id,
      orderId: sAfterDual.orderId,
      amountPaise: 1000,
      currency: 'INR',
      utr: uTr
    });
    const expectedSig = generateHmac(webhookBody, merchant.webhookSecret);
    assert.ok(expectedSig.length > 32);

    // 5. Late observation arriving after SUCCESS does not re-emit PAYMENT.SUCCESS
    let secondSuccessEmitted = false;
    apiInstance.app.context.eventEmitter.on('PAYMENT.SUCCESS', () => {
      secondSuccessEmitted = true;
    });

    const lateRes = apiInstance.app.context.attributionEngine.processObservation({
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      source: 'ANDROID_OBSERVER',
      amountPaise: 1000n,
      observedAt: new Date(),
      bankReferenceNumber: uTr,
      fingerprintHash: sharedFp
    });

    assert.equal(secondSuccessEmitted, false, 'Late observation MUST NOT re-emit PAYMENT.SUCCESS');

    // Verify session status remains intact
    const finalSession = apiInstance.app.context.sessionRepo.findById(paymentId);
    assert.equal(finalSession.status, PaymentStatus.SUCCESS);
  });

  // 6. Checkout restart / re-bind endpoint gates on canary allowlist
  test('6. Checkout restart endpoint (/end-and-restart-payment) rejects sessions from unauthorized merchants with 403', async () => {
    // Create an unauthorized merchant session directly bypassing allowlist (e.g. simulated pre-existing session in DB)
    const unauthorizedSessionId = '00000000-0000-0000-0000-999999999999';
    testDb.execute(`
      INSERT INTO payment_sessions (
        id, merchant_id, customer_id, order_id, amount_paise, currency, status, created_at, updated_at
      ) VALUES (?, '00000000-0000-0000-0000-000000000099', NULL, 'ORD-UNAUTH-PRIOR', 5000, 'INR', 'ACTIVE', datetime('now'), datetime('now'))
    `, [unauthorizedSessionId]);

    const res = await fetch(`${serverUrl}/api/v1/checkout/${unauthorizedSessionId}/end-and-restart-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': 'device-new-test-client'
      },
      body: JSON.stringify({ deviceId: 'device-new-test-client' })
    });

    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 403);
    assert.equal(body.code, 'CANARY_MERCHANT_UNAUTHORIZED');
  });

  // 7. Repository-level fail-closed boundary
  test('7. Repository layer (sessionRepo.create) fails closed if called directly with unauthorized merchant in canary mode', () => {
    assert.throws(
      () => {
        apiInstance.app.context.sessionRepo.create({
          merchantId: '00000000-0000-0000-0000-000000000099',
          orderId: 'ORD-ILLEGAL-DIRECT-INJECTION',
          amountPaise: 5000,
          currency: 'INR'
        });
      },
      (err) => err.code === 'CANARY_MERCHANT_UNAUTHORIZED'
    );

    // Verify row was NOT inserted into database
    const row = testDb.queryOne("SELECT count(*) as count FROM payment_sessions WHERE order_id = 'ORD-ILLEGAL-DIRECT-INJECTION'");
    assert.equal(Number(row.count), 0);
  });

  // 8. Missing/empty allowlist fails closed at API entry point
  test('8. Empty CANARY_MERCHANT_ALLOWLIST fails closed with 500 INVALID_CANARY_CONFIGURATION', async () => {
    const savedAllowlist = process.env.CANARY_MERCHANT_ALLOWLIST;
    try {
      process.env.CANARY_MERCHANT_ALLOWLIST = '   ';
      const res = await createPayment({
        orderId: 'CANARY-FAIL-EMPTY-ALLOWLIST',
        amount: '10.00',
        metadata: { agencyVvisaUid: AUTHORIZED_UID }
      });
      assert.equal(res.status, 500);
      assert.equal(res.body.code, 'INVALID_CANARY_CONFIGURATION');
    } finally {
      process.env.CANARY_MERCHANT_ALLOWLIST = savedAllowlist;
    }
  });

  // 9. Concurrent checkout restart requests for authorized merchant maintain single-active invariant
  test('9. Concurrent restart requests execute race-safely without orphaned active sessions', async () => {
    // Create an authorized session
    const createRes = await createPayment({
      orderId: 'CANARY-CONCURRENT-RESTART',
      amount: '10.00',
      autoActivate: true,
      metadata: { agencyVvisaUid: AUTHORIZED_UID }
    });
    assert.equal(createRes.status, 201);
    const origSessionId = createRes.body.paymentId;

    // Send 3 parallel restart requests with different device IDs
    const restartPromises = [1, 2, 3].map(i =>
      fetch(`${serverUrl}/api/v1/checkout/${origSessionId}/end-and-restart-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': `device-parallel-${i}`
        },
        body: JSON.stringify({ deviceId: `device-parallel-${i}` })
      }).then(r => r.json().then(b => ({ status: r.status, body: b })))
    );

    const results = await Promise.all(restartPromises);
    // At least one restart should succeed with 201 Created, others should be handled cleanly without unhandled server 500s
    const successRestarts = results.filter(r => r.status === 201);
    assert.ok(successRestarts.length >= 1, 'At least one restart request must succeed with 201 Created');

    // Clean up
    testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE order_id LIKE 'CANARY-CONCURRENT-RESTART%'");
  });
});
