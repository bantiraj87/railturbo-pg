import { AndroidObserverDriver } from '../apps/android-observer-app/driver.js';
import { resolveSecret, createPairingPayload, validatePairingPayload } from '../packages/common/src/index.js';
import http from 'node:http';

async function runStagingVerification() {
  console.log('====================================================');
  console.log('🔍 YouPI Gate 1 — Tunnel Staging Verification Suite');
  console.log('====================================================');

  const CHECKOUT_BASE = 'http://localhost:7000';
  const API_BASE = 'http://localhost:6100';

  // 1. Create a test payment session
  console.log('\n[1/5] Creating simulated test payment session on Payment Core API...');
  const initRes = await fetch(`${API_BASE}/api/v1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: `STAGING-TEST-${Date.now()}`,
      amount: '1.00',
      currency: 'INR',
      autoActivate: true,
      customer: {
        name: 'Staging Tester',
        phoneNumber: '9876543210'
      }
    })
  });

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`Failed to create payment session: ${initRes.status} ${err}`);
  }

  const sessionData = await initRes.json();
  const paymentId = sessionData.id || sessionData.paymentId;
  console.log(`[✓] Test Session Created: ${paymentId} (Status: ${sessionData.status})`);

  // 2. Test Checkout HTML Rendering through Checkout Portal
  console.log('\n[2/5] Testing Checkout Portal HTML rendering...');
  const checkoutRes = await fetch(`${CHECKOUT_BASE}/checkout/${paymentId}`);
  if (!checkoutRes.ok) {
    throw new Error(`Failed to render checkout: ${checkoutRes.status}`);
  }
  const checkoutHtml = await checkoutRes.text();
  if (!checkoutHtml.includes(paymentId)) {
    throw new Error('Rendered HTML missing paymentId token');
  }
  console.log(`[✓] Checkout HTML Rendered successfully (${checkoutHtml.length} bytes, contains paymentId)`);

  // 3. Test Android Observer Pairing
  console.log('\n[3/5] Testing Android Observer QR Pairing Payload & Registration...');
  const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
  
  // Validate pairing payload format
  const qrPayload = createPairingPayload({
    serverUrl: 'https://pay-api.vvisa.in',
    sessionId: `pair_${Date.now()}`
  });
  const qrValidation = validatePairingPayload(qrPayload);
  if (!qrValidation.valid) {
    throw new Error(`QR Payload invalid: ${qrValidation.error}`);
  }
  console.log(`[✓] QR Pairing Payload Validated (serverUrl: ${qrPayload.serverUrl})`);

  // Pair driver with Payment API
  const driver = new AndroidObserverDriver({
    apiBaseUrl: API_BASE,
    deviceName: 'Pixel 8 Pro Staging',
    deviceModel: 'Pixel 8'
  });

  const pairResult = await driver.pair(enrollmentSecret);
  console.log(`[✓] Android Observer Paired (deviceId: ${pairResult.deviceId})`);

  // 4. Test Android Heartbeat
  console.log('\n[4/5] Testing Android Heartbeat Liveness Signal...');
  const hb = await driver.sendHeartbeat();
  if (hb.status !== 'HEARTBEAT_ACK') {
    throw new Error(`Unexpected heartbeat status: ${JSON.stringify(hb)}`);
  }
  console.log(`[✓] Heartbeat Acknowledged: ${hb.status} at ${hb.timestamp}`);

  // 5. Test Authenticated Bank Observation Ingestion
  console.log('\n[5/5] Testing Signed Observation Ingestion & Attribution...');
  // First simulate customer clicking "I have paid"
  await fetch(`${API_BASE}/api/v1/checkout/${paymentId}/done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  const obsResult = await driver.submitObservation({
    amount: '1.00',
    utr: `UTR-STAGING-${Date.now()}`,
    senderVpa: 'vinod@upi',
    notificationText: `Payment of Rs 1.00 received from vinod@upi on PhonePe`
  });

  if (obsResult.status !== 200 || !obsResult.body.accepted) {
    throw new Error(`Observation ingestion failed: HTTP ${obsResult.status} ${JSON.stringify(obsResult.body)}`);
  }

  console.log(`[✓] Observation Ingested & Accepted:`, {
    accepted: obsResult.body.accepted,
    attributed: obsResult.body.attribution?.attributed,
    outcomeStatus: obsResult.body.attribution?.outcomeStatus
  });

  console.log('Waiting 5.5s for AttributionEngine grace timer to finalize Level 1 SUCCESS...');
  await new Promise(r => setTimeout(r, 5500));

  // Verify final session state
  const stateRes = await fetch(`${API_BASE}/api/v1/checkout/${paymentId}/state`);
  const finalState = await stateRes.json();
  console.log(`[✓] Final Payment Session State: ${finalState.status}`);

  if (finalState.status !== 'SUCCESS') {
    throw new Error(`Expected final status SUCCESS, got ${finalState.status}`);
  }

  console.log('\n====================================================');
  console.log('🎉 ALL STAGING VERIFICATIONS PASSED SUCCESSFULLY');
  console.log('====================================================');
}

runStagingVerification().catch(err => {
  console.error('\n❌ Staging Verification Failed:', err);
  process.exit(1);
});
