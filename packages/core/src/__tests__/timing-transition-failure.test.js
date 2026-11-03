import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database, runMigrations, PaymentSessionRepository } from '@youpi/db';
import { TimingEngine } from '../timing-engine.js';

test('failed Payment Done transition preserves the active expiration timer', () => {
  const engine = new TimingEngine({
    sessionRepo: { transitionToProcessing() { throw new Error('temporary database failure'); } },
    queueEngine: {}
  });
  engine.startActiveTimer('session', new Date(Date.now() + 60000));
  const before = engine.activeTimers.get('session');
  try {
    assert.throws(() => engine.handlePaymentDone('session'), /temporary database failure/);
    assert.equal(engine.activeTimers.get('session'), before);
    assert.equal(engine.processingTimers.size, 0);
  } finally {
    engine.destroy();
  }
});

test('successful Payment Done transition still replaces the active timer', () => {
  const engine = new TimingEngine({
    sessionRepo: { transitionToProcessing: () => ({ id: 'session', processingExpiresAt: new Date(Date.now() + 30000) }) },
    queueEngine: {}
  });
  engine.startActiveTimer('session', new Date(Date.now() + 60000));
  try {
    engine.handlePaymentDone('session');
    assert.equal(engine.activeTimers.has('session'), false);
    assert.equal(engine.processingTimers.has('session'), true);
  } finally {
    engine.destroy();
  }
});

test('a failed transition still lets the original active deadline expire the session', async () => {
  let status = 'ACTIVE';
  const events = [];
  const engine = new TimingEngine({
    sessionRepo: {
      transitionToProcessing() { throw new Error('temporary database failure'); },
      findById: () => ({ status, receivingAccountId: 'account' }),
      transitionToTerminal(_id, target) { status = target; }
    },
    queueEngine: { promoteNext() {} },
    eventEmitter: { emit: (event) => events.push(event) }
  });
  engine.startActiveTimer('session', new Date(Date.now() + 20));
  try {
    assert.throws(() => engine.handlePaymentDone('session'), /temporary database failure/);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(status, 'EXPIRED');
    assert.ok(events.includes('PAYMENT.EXPIRED'));
  } finally {
    engine.destroy();
  }
});


test('database transaction failure keeps an actual ACTIVE session and deadline', () => {
  const db = new Database({ inMemory: true });
  const merchant = runMigrations(db).defaultMerchant;
  const repo = new PaymentSessionRepository(db);
  const session = repo.create({ merchantId: merchant.id, receivingAccountId: '00000000-0000-0000-0000-000000000002', orderId: 'TIMER-ROLLBACK', amountPaise: 10000n });
  repo.acquireSlotAtomic(session.id, session.receivingAccountId, 60000);
  const engine = new TimingEngine({ sessionRepo: repo, queueEngine: {} });
  engine.startActiveTimer(session.id, new Date(Date.now() + 60000));
  const before = engine.activeTimers.get(session.id);
  const transaction = db.transaction;
  db.transaction = () => { throw new Error('temporary transaction failure'); };
  try {
    assert.throws(() => engine.handlePaymentDone(session.id), /temporary transaction failure/);
    assert.equal(repo.findById(session.id).status, 'ACTIVE');
    assert.equal(engine.activeTimers.get(session.id), before);
  } finally {
    db.transaction = transaction;
    engine.destroy();
    db.close();
  }
});
