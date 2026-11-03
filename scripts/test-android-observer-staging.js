import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database, runMigrations } from '../packages/db/src/index.js';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../apps/android-observer-app/driver.js';
import { PaymentStatus, resolveSecret } from '../packages/common/src/index.js';

describe('Android Observer Staging Verification Suite', () => {
  let apiInstance;
  let driver;
  let testDb;
  let defaultMerchant;
  let receivingAccount;

  before(async () => {
    testDb = new Database({ inMemory: true });
    const seed = runMigrations(testDb);
    defaultMerchant = seed.defaultMerchant;
    receivingAccount = { id: '00000000-0000-0000-0000-000000000002' };

    // Start payment API on ephemeral test port
    apiInstance = await startPaymentApi(6219, testDb);
    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      deviceName: 'Pixel 8 Pro Staging Tester',
      deviceModel: 'Pixel 8 Pro'
    });
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  test('1. Android Pairing Security: Rejects pairing with invalid enrollment secret', async () => {
    await assert.rejects(
      () => driver.pair('invalid_unauthorized_secret_999'),
      /Device pairing failed/
    );
  });

  test('2. Android Pairing Success: Establishes device credentials with valid enrollment secret', async () => {
    const secret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
    const pairResult = await driver.pair(secret, defaultMerchant.id);

    assert.ok(pairResult.paired, 'Expected paired: true');
    assert.ok(pairResult.deviceId, 'Expected non-empty deviceId');
    assert.ok(pairResult.signingKey, 'Expected non-empty signingKey');
    assert.equal(driver.deviceId, pairResult.deviceId);
  });

  test('3. Android Heartbeat: Sends signed liveness signal and receives HEARTBEAT_ACK', async () => {
    const hb = await driver.sendHeartbeat();
    assert.equal(hb.status, 'HEARTBEAT_ACK');
    assert.ok(hb.timestamp, 'Expected server timestamp in ack');
  });

  test('4. Replay Protection: Rejects observations with expired or drifted timestamps', async () => {
    const staleTimestamp = Date.now() - 90000; // 90 seconds in the past (> 60s window)
    const res = await driver.submitObservation({
      amount: '150.00',
      timestampOverride: staleTimestamp
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error.includes('validity window'));
  });

  test('5. Unassigned Ingestion: Observation without matching active session is safely recorded without corrupting state', async () => {
    const res = await driver.submitObservation({
      amount: '999.00',
      receivingAccountId: receivingAccount.id,
      utr: 'UTR-ORPHAN-001',
      senderVpa: 'stranger@okhdfcbank',
      notificationText: 'Payment of ₹999 received from stranger@okhdfcbank'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    // When no active session matches the amount/VPA, it must not falsely attribute
    assert.equal(res.body.attribution?.attributed, false);

    // Verify observation is persisted in payment_observations
    const obs = testDb.queryOne(
      'SELECT * FROM payment_observations WHERE bank_reference_number = ?',
      ['UTR-ORPHAN-001']
    );
    assert.ok(obs, 'Orphan observation must be saved in database');
    assert.equal(obs.amount_paise, 99900);
  });

  test('6. Authenticated Attribution: Observation matching active session confirms payment and records UTR', async () => {
    // 1. Create and activate a payment session for ₹250
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: receivingAccount.id,
      orderId: 'ANDR-STAGING-ORD-250',
      amountPaise: 25000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, receivingAccount.id);
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    // 2. Submit signed Android observation
    const res = await driver.submitObservation({
      amount: '250.00',
      receivingAccountId: receivingAccount.id,
      utr: 'UTR-STAGING-250001',
      senderVpa: 'payer@upi',
      notificationText: 'Payment of ₹250 received from payer@upi on Google Pay'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution?.attributed, true);
    assert.equal(res.body.attribution?.paymentSessionId, session.id);
    assert.equal(res.body.attribution?.outcomeStatus, PaymentStatus.SUCCESS);

    // 3. Verify session in DB updated to SUCCESS with attributed observation
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.SUCCESS);
    assert.ok(updated.attributedObservationId);

    // 4. Verify observation in DB has correct UTR
    const obs = testDb.queryOne(
      'SELECT bank_reference_number FROM payment_observations WHERE id = ?',
      [updated.attributedObservationId]
    );
    assert.equal(obs.bank_reference_number, 'UTR-STAGING-250001');
  });
});
