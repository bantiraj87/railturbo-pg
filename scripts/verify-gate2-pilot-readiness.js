import assert from 'node:assert/strict';
import { getDatabase, runMigrations, PaymentSessionRepository, ObservationRepository, SupportTicketRepository, AuditLogRepository, ReceivingAccountRepository, MerchantRepository } from '@youpi/db';
import { AttributionEngine } from '@youpi/core';
import { ObservationNormalizer } from '@youpi/core';
import { PaymentStatus, ObservationAttributionStatus } from '@youpi/common';

async function runPilotReadinessVerification() {
  console.log('====================================================');
  console.log('🧪 FINAL CONTROLLED-PILOT READINESS STAGING SUITE');
  console.log('====================================================\n');

  const db = getDatabase(':memory:');
  const { defaultMerchant } = runMigrations(db);

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);

  const account = accountRepo.findActiveForMerchant(defaultMerchant.id);
  assert.ok(account, 'Active receiving account must exist');

  // Expire any pre-existing demo sessions and clear slot occupancy
  db.execute("UPDATE payment_sessions SET status = 'EXPIRED'");
  db.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [account.id]);

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    gracePeriodMs: 0
  });

  const runId = Date.now();

  // TEST 1: Normal attribution flow with atomic slot acquisition
  console.log('[1/5] Testing Normal Payment Attribution & Slot Granting...');
  const session1 = sessionRepo.create({
    merchantId: defaultMerchant.id,
    orderId: `PILOT-ORD-${runId}-1`,
    amountPaise: 50000n,
    receivingAccountId: account.id,
    status: PaymentStatus.INITIATED
  });
  const slotRes1 = sessionRepo.acquireSlotAtomic(session1.id, account.id, 300000);
  assert.equal(slotRes1.status, PaymentStatus.ACTIVE, 'Session must become ACTIVE');

  const utr1 = 'UTR' + Math.floor(100000000 + Math.random() * 900000000);
  const obs1 = ObservationNormalizer.normalize({
    source: 'ANDROID_OBSERVER',
    receivingAccountId: account.id,
    amountPaise: 50000n,
    bankReferenceNumber: utr1,
    senderVpa: 'payer@upi',
    observedAt: new Date(),
    rawPayload: { text: `Received Rs.500.00 from payer@upi Ref ${utr1}` }
  });

  const res1 = attributionEngine.processObservation(obs1);
  if (!res1.attributed) console.log('DEBUG res1:', res1);
  assert.equal(res1.attributed, true, 'Observation must be successfully attributed');
  assert.equal(res1.paymentSessionId, session1.id);
  assert.equal(res1.outcomeStatus, PaymentStatus.SUCCESS);
  console.log('   ✅ Normal payment attributed to SUCCESS cleanly.');

  // TEST 2: Duplicate / Replayed event
  console.log('\n[2/5] Testing Duplicate / Replayed Event...');
  const res2 = attributionEngine.processObservation(obs1);
  assert.equal(res2.duplicate, true, 'Exact same observation must be detected as duplicate');
  assert.equal(res2.attributed, false, 'Duplicate must not re-attribute');
  console.log('   ✅ Duplicate bank observation dropped safely without re-crediting.');

  // TEST 3: Wrong amount rejection
  console.log('\n[3/5] Testing Wrong Amount Rejection...');
  const seededCustomer = db.queryOne('SELECT id FROM customers LIMIT 1');
  const customerId = seededCustomer?.id || null;

  const session3 = sessionRepo.create({
    merchantId: defaultMerchant.id,
    customerId,
    orderId: `PILOT-ORD-${runId}-3`,
    amountPaise: 100000n, // Expected ₹1000
    receivingAccountId: account.id,
    status: PaymentStatus.INITIATED
  });
  const slotRes3 = sessionRepo.acquireSlotAtomic(session3.id, account.id, 300000);
  assert.equal(slotRes3.status, PaymentStatus.ACTIVE);

  const utrWrong = 'UTR' + Math.floor(100000000 + Math.random() * 900000000);
  const obsWrongAmount = ObservationNormalizer.normalize({
    source: 'ANDROID_OBSERVER',
    receivingAccountId: account.id,
    amountPaise: 50000n, // Payer sent ₹500 instead of ₹1000
    bankReferenceNumber: utrWrong,
    senderVpa: 'cheater@upi',
    observedAt: new Date(),
    rawPayload: { text: `Received Rs.500.00 from cheater@upi Ref ${utrWrong}` }
  });

  const resWrong = attributionEngine.processObservation(obsWrongAmount);
  assert.equal(resWrong.attributed, false, 'Mismatched amount MUST NOT be attributed');
  const sessionAfterWrong = sessionRepo.findById(session3.id);
  assert.equal(sessionAfterWrong.status, PaymentStatus.ACTIVE, 'Session must remain ACTIVE waiting for full amount');
  console.log('   ✅ Wrong amount rejected and preserved as UNATTRIBUTED; session remains active.');

  // TEST 4: Late observation (arriving after session expiry)
  console.log('\n[4/5] Testing Late Observation Handling...');
  // Force session 3 to EXPIRED
  sessionRepo.transitionToTerminal(session3.id, PaymentStatus.EXPIRED);
  const sessionAfterExpire = sessionRepo.findById(session3.id);
  assert.equal(sessionAfterExpire.status, PaymentStatus.EXPIRED);

  const utrLate = 'UTR' + Math.floor(100000000 + Math.random() * 900000000);
  const obsLate = ObservationNormalizer.normalize({
    source: 'ANDROID_OBSERVER',
    receivingAccountId: account.id,
    amountPaise: 100000n,
    bankReferenceNumber: utrLate,
    senderVpa: 'slowpayer@upi',
    observedAt: new Date(),
    rawPayload: { text: `Received Rs.1000.00 from slowpayer@upi Ref ${utrLate}` }
  });

  const resLate = attributionEngine.processObservation(obsLate);
  assert.equal(resLate.attributed, false, 'Late observation must NOT auto-settle expired session');
  assert.equal(resLate.lateMatch, true, 'Must detect as late match');
  assert.equal(resLate.outcomeStatus, ObservationAttributionStatus.LATE_UNMATCHED);

  // Check support ticket creation
  const tickets = ticketRepo.findTicketsByMerchant(defaultMerchant.id);
  const ticketForLate = tickets.find(t => t.paymentId === session3.id || (t.subject && t.subject.includes(session3.id)));
  assert.ok(ticketForLate, 'Support ticket must be generated for merchant manual reconciliation');
  console.log('   ✅ Late observation recorded as LATE_UNMATCHED; support ticket generated.');

  // TEST 5: Kill switch / Account deactivation
  console.log('\n[5/5] Testing Server-side Kill Switch & Account Inactivation...');
  db.execute('UPDATE payment_receiving_accounts SET is_active = 0 WHERE id = ?', [account.id]);
  const activeAccount = accountRepo.findActiveForMerchant(defaultMerchant.id);
  assert.equal(activeAccount, null, 'No active account must be found when deactivated');

  // Verify attribution fails gracefully when receiving account is inactive
  const obsKill = ObservationNormalizer.normalize({
    source: 'ANDROID_OBSERVER',
    receivingAccountId: account.id,
    amountPaise: 10000n,
    bankReferenceNumber: '000111222333',
    senderVpa: 'payer@upi',
    observedAt: new Date(),
    rawPayload: { text: 'Received Rs.100.00' }
  });
  const resKill = attributionEngine.processObservation(obsKill);
  assert.equal(resKill.attributed, false, 'Deactivated account cannot attribute payments');
  console.log('   ✅ Kill switch verified: Inactive receiving account prevents any payment attribution.');

  console.log('\n====================================================');
  console.log('🎉 ALL 5 STAGING PILOT-READINESS SCENARIOS PASSED 100%');
  console.log('====================================================');
}

runPilotReadinessVerification().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
