import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ReceivingAccountRepository,
  MerchantRepository,
  DeviceRepository
} from '@youpi/db';
import { startServer as startPaymentApi } from '../../../../apps/payment-api/src/index.js';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';
import { SmsObserverService } from '../../../../apps/sms-observer/src/sms-service.js';
import { GmailPoller } from '../../../../apps/gmail-observer/src/gmail-poller.js';
import { PaymentStatus } from '@youpi/common';

describe('Phase 9C: Observer Isolation & Concurrency Hardening Suite', () => {
  let db;
  let apiInstance;
  let baseUrl;
  let sessionRepo;
  let accountRepo;
  let merchantRepo;
  let deviceRepo;

  let merchantA;
  let merchantB;
  let accountA;
  let accountB;
  let deviceA;

  const httpReq = async (method, path, { token, headers = {}, body = null } = {}) => {
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    };
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, body: data };
  };

  before(async () => {
    db = new Database({ inMemory: true });
    runMigrations(db);

    merchantRepo = new MerchantRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    deviceRepo = new DeviceRepository(db);

    // Merchant A: V-Visa Staging
    merchantA = merchantRepo.create({
      businessName: 'V-Visa B2B Staging',
      slug: 'vvisa-b2b',
      contactEmail: 'ops@vvisa.in',
      contactPhone: '9876543210',
      webhookUrl: 'http://localhost:3000/api/payments/youpi/webhook',
      webhookSecret: 'secret_a_staging'
    });

    // Merchant B: Unrelated External Agency
    merchantB = merchantRepo.create({
      businessName: 'External Merchant Ltd',
      slug: 'external-merchant',
      contactEmail: 'admin@external.in',
      contactPhone: '9876543211',
      webhookUrl: 'http://localhost:4000/api/payments/webhook',
      webhookSecret: 'secret_b_staging'
    });

    // Account A for Merchant A
    accountA = accountRepo.create({
      merchantId: merchantA.id,
      upiId: 'vvisab2b@icici',
      payeeName: 'V-Visa B2B Tech',
      isMerchantEnabled: true,
      isActive: true
    });

    // Account B for Merchant B
    accountB = accountRepo.create({
      merchantId: merchantB.id,
      upiId: 'external@hdfcbank',
      payeeName: 'External Merchant Co',
      isMerchantEnabled: true,
      isActive: true
    });

    // Device A enrolled to Merchant A
    const deviceId = 'android_dev_test_123';
    db.run(`
      INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [deviceId, merchantA.id, 'Pixel 7 Observer', 'Pixel 7', 'hash123']);
    deviceA = { id: deviceId };

    apiInstance = await startPaymentApi(6198, db);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    db.close();
  });

  // --------------------------------------------------------------------------
  // Fix 1: Active-Window Route Protection and Scoping
  // --------------------------------------------------------------------------
  test('Fix 1.1: GET /api/v1/pollers/active-window without credentials returns 401', async () => {
    const res = await httpReq('GET', '/api/v1/pollers/active-window');
    assert.equal(res.status, 401);
  });

  test('Fix 1.2: GET /api/v1/pollers/active-window with invalid token returns 401', async () => {
    const res = await httpReq('GET', '/api/v1/pollers/active-window', { token: 'invalid_secret_token' });
    assert.equal(res.status, 401);
  });

  test('Fix 1.3: Observer token without receivingAccountId returns 400 ACCOUNT_BINDING_REQUIRED', async () => {
    const res = await httpReq('GET', '/api/v1/pollers/active-window', { token: TEST_OBSERVER_TOKEN });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'ACCOUNT_BINDING_REQUIRED');
  });

  test('Fix 1.4: Observer token querying non-existent account returns 403 INVALID_RECEIVING_ACCOUNT', async () => {
    const res = await httpReq('GET', '/api/v1/pollers/active-window?receivingAccountId=non-existent-uuid', {
      token: TEST_OBSERVER_TOKEN
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'INVALID_RECEIVING_ACCOUNT');
  });

  test('Fix 1.5: Observer token with mismatched merchantId returns 403 MERCHANT_ACCOUNT_MISMATCH', async () => {
    // accountA belongs to merchantA, but query specifies merchantB
    const res = await httpReq(
      'GET',
      `/api/v1/pollers/active-window?receivingAccountId=${accountA.id}&merchantId=${merchantB.id}`,
      { token: TEST_OBSERVER_TOKEN }
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'MERCHANT_ACCOUNT_MISMATCH');
  });

  test('Fix 1.6: Observer query returns ONLY sessions scoped to the authorized receiving account', async () => {
    // Create an active session for accountA
    const sessionA = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      amountPaise: 50000,
      orderId: 'ORDER_A_101',
      status: PaymentStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 600000)
    });

    // Create an active session for accountB
    const sessionB = sessionRepo.create({
      merchantId: merchantB.id,
      receivingAccountId: accountB.id,
      amountPaise: 90000,
      orderId: 'ORDER_B_202',
      status: PaymentStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 600000)
    });

    // Query active window for accountA
    const resA = await httpReq(
      'GET',
      `/api/v1/pollers/active-window?receivingAccountId=${accountA.id}`,
      { token: TEST_OBSERVER_TOKEN }
    );
    assert.equal(resA.status, 200);
    assert.equal(resA.body.hasActivePayment, true);
    assert.equal(resA.body.receivingAccountId, accountA.id);
    assert.equal(resA.body.sessions.length, 1);
    assert.equal(resA.body.sessions[0].id, sessionA.id);
    assert.equal(resA.body.sessions[0].orderId, 'ORDER_A_101');

    // Clean up sessionA & sessionB
    db.run('DELETE FROM payment_sessions WHERE id IN (?, ?)', [sessionA.id, sessionB.id]);
  });

  test('Fix 1.7: Android observer device authentication scopes to merchant account and prevents spoofing', async () => {
    // Unregistered device header
    const badDeviceRes = await httpReq('GET', '/api/v1/pollers/active-window', {
      token: TEST_OBSERVER_TOKEN,
      headers: { 'X-Device-Id': 'non-existent-device-id' }
    });
    assert.equal(badDeviceRes.status, 403);
    assert.equal(badDeviceRes.body.code, 'DEVICE_UNAUTHORIZED');

    // Registered device header: auto-binds to merchantA's accountA
    const goodDeviceRes = await httpReq('GET', '/api/v1/pollers/active-window', {
      token: TEST_OBSERVER_TOKEN,
      headers: { 'X-Device-Id': deviceA.id }
    });
    assert.equal(goodDeviceRes.status, 200);
    assert.equal(goodDeviceRes.body.receivingAccountId, accountA.id);

    // Anti-spoofing: Registered device tries to request accountB (cross-account)
    const spoofRes = await httpReq(
      'GET',
      `/api/v1/pollers/active-window?receivingAccountId=${accountB.id}`,
      { token: TEST_OBSERVER_TOKEN, headers: { 'X-Device-Id': deviceA.id } }
    );
    assert.equal(spoofRes.status, 403);
    assert.equal(spoofRes.body.code, 'CROSS_ACCOUNT_FORBIDDEN');
  });

  // --------------------------------------------------------------------------
  // Fix 2: Elimination of Account Guessing in Observers
  // --------------------------------------------------------------------------
  test('Fix 2.1: SmsObserverService without receivingAccountId fails closed without guessing', async () => {
    const unconfiguredSmsService = new SmsObserverService({
      apiBaseUrl: baseUrl,
      receivingAccountId: null
    });

    const result = await unconfiguredSmsService.processSms({
      text: 'Rs 500 credited to account XX1234 on 19-Oct-26 UPI/CR/123456789012/test',
      sender: 'HDFCBK'
    });

    // Must return null, zero observation recorded, zero dynamic guessing
    assert.equal(result, null);
    assert.equal(unconfiguredSmsService.observedCount, 0);
  });

  test('Fix 2.2: GmailPoller without receivingAccountId fails closed without guessing', async () => {
    const unconfiguredGmailPoller = new GmailPoller({
      apiBaseUrl: baseUrl,
      receivingAccountId: null
    });

    const result = await unconfiguredGmailPoller.processEmail({
      subject: 'Credit Alert: Rs 750 received via UPI',
      body: 'Your account has been credited with Rs 750.00 via UPI Ref 998877665544.',
      from: 'alerts@hdfcbank.net'
    });

    // Must return null, zero observation recorded, zero dynamic guessing
    assert.equal(result, null);
    assert.equal(unconfiguredGmailPoller.observedCount, 0);
  });

  // --------------------------------------------------------------------------
  // Fix 3: Single-Active-Session DB Invariant (idx_single_active_session)
  // --------------------------------------------------------------------------
  test('Fix 3.1: Database unique index idx_single_active_session rejects 2nd ACTIVE session on same account', () => {
    // Clean up any sessions left by prior tests on this account
    db.run(`DELETE FROM payment_sessions WHERE receiving_account_id = ?`, [accountA.id]);

    const active1 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      amountPaise: 10000,
      orderId: 'ORD_UNIQUE_1',
      status: PaymentStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 300000)
    });
    assert.ok(active1.id);

    // Attempting direct raw insert of a second ACTIVE session on same account must throw unique violation
    assert.throws(() => {
      db.run(`
        INSERT INTO payment_sessions (id, merchant_id, receiving_account_id, amount_paise, order_id, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        'violating-session-id',
        merchantA.id,
        accountA.id,
        20000,
        'ORD_UNIQUE_2',
        PaymentStatus.ACTIVE,
        new Date().toISOString(),
        new Date(Date.now() + 300000).toISOString()
      ]);
    }, /(UNIQUE constraint failed|idx_single_active_session)/);

    // Clean up
    db.run('DELETE FROM payment_sessions WHERE id = ?', [active1.id]);
  });

  test('Fix 3.2: Concurrent ACTIVE sessions on DIFFERENT receiving accounts are permitted', () => {
    // Clean up any sessions left by prior tests on this account
    db.run(`DELETE FROM payment_sessions WHERE receiving_account_id = ?`, [accountA.id]);
    db.run(`DELETE FROM payment_sessions WHERE receiving_account_id = ?`, [accountB.id]);

    const activeA = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      amountPaise: 15000,
      orderId: 'ORD_MULTI_A',
      status: PaymentStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 300000)
    });

    const activeB = sessionRepo.create({
      merchantId: merchantB.id,
      receivingAccountId: accountB.id,
      amountPaise: 25000,
      orderId: 'ORD_MULTI_B',
      status: PaymentStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 300000)
    });

    assert.ok(activeA.id);
    assert.ok(activeB.id);

    // Both are simultaneously ACTIVE
    assert.equal(sessionRepo.findById(activeA.id).status, PaymentStatus.ACTIVE);
    assert.equal(sessionRepo.findById(activeB.id).status, PaymentStatus.ACTIVE);

    // Clean up
    db.run('DELETE FROM payment_sessions WHERE id IN (?, ?)', [activeA.id, activeB.id]);
  });

  test('Fix 3.3: acquireSlotAtomic queues 2nd request gracefully when slot is occupied', () => {
    // Clean up any sessions left by prior tests on this account
    db.run(`DELETE FROM payment_sessions WHERE receiving_account_id = ?`, [accountA.id]);

    const session1 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      amountPaise: 12000,
      orderId: 'ORD_ATOMIC_1',
      status: PaymentStatus.QUEUED,
      expiresAt: new Date(Date.now() + 300000)
    });

    const session2 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      amountPaise: 14000,
      orderId: 'ORD_ATOMIC_2',
      status: PaymentStatus.QUEUED,
      expiresAt: new Date(Date.now() + 300000)
    });

    // 1st request acquires ACTIVE slot
    const slot1 = sessionRepo.acquireSlotAtomic(session1.id, accountA.id, 300000);
    assert.equal(slot1.status, PaymentStatus.ACTIVE);
    assert.equal(slot1.queuePosition, 0);

    // 2nd request to same receiving account falls back cleanly to QUEUED
    const slot2 = sessionRepo.acquireSlotAtomic(session2.id, accountA.id, 300000);
    assert.equal(slot2.status, PaymentStatus.QUEUED);
    assert.equal(slot2.queuePosition, 1);

    // Clean up
    db.run('DELETE FROM payment_sessions WHERE id IN (?, ?)', [session1.id, session2.id]);
  });

  // --------------------------------------------------------------------------
  // Fix 4: Concurrency & Lock Contention Resilience
  // --------------------------------------------------------------------------
  test('Fix 4.1: Concurrent acquireSlotAtomic race results in 1 ACTIVE and remaining QUEUED with 0 errors', () => {
    // Clean up any sessions left by prior tests on this account
    db.run(`DELETE FROM payment_sessions WHERE receiving_account_id = ?`, [accountA.id]);

    const concurrentCount = 5;
    const sessionIds = [];

    for (let i = 0; i < concurrentCount; i++) {
      const s = sessionRepo.create({
        merchantId: merchantA.id,
        receivingAccountId: accountA.id,
        amountPaise: 10000 + (i * 100),
        orderId: `ORD_CONCUR_${i}`,
        status: PaymentStatus.QUEUED,
        expiresAt: new Date(Date.now() + 300000)
      });
      sessionIds.push(s.id);
    }

    const results = sessionIds.map(sid =>
      sessionRepo.acquireSlotAtomic(sid, accountA.id, 300000)
    );

    const activeSessions = results.filter(r => r.status === PaymentStatus.ACTIVE);
    const queuedSessions = results.filter(r => r.status === PaymentStatus.QUEUED);

    // Invariant: Exactly 1 ACTIVE, exactly (concurrentCount - 1) QUEUED
    assert.equal(activeSessions.length, 1);
    assert.equal(queuedSessions.length, concurrentCount - 1);

    // Clean up
    db.run(`DELETE FROM payment_sessions WHERE id IN (${sessionIds.map(() => '?').join(',')})`, sessionIds);
  });

  test('Fix 4.2: Database withRetry retries transient busy operations successfully', () => {
    let attempts = 0;
    const fakeBusyOperation = () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('SQLITE_BUSY: database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'SUCCESS_AFTER_RETRY';
    };

    const result = db.withRetry(fakeBusyOperation, 4, 10);
    assert.equal(result, 'SUCCESS_AFTER_RETRY');
    assert.equal(attempts, 3);
  });
});
