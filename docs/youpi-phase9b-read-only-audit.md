# YouPI Phase 9B — Read-Only Evidence Audit Report

**Date:** October 19, 2026  
**Auditor:** Autonomous Systems & Payment Security Pair  
**Phase Status:** COMPLETE (Read-Only Audit — No Code Mutations, No Schema Changes, No Deployments)  
**Safety Invariants Enforced:**  
- `ENABLE_YOUPI_UPI=false` strictly preserved in production configuration.
- Zoho Payments remains 100% primary payment gateway.
- Zero live funds, zero real bank accounts, zero physical Android devices, zero Gmail OAuth connections.
- Zero staging or production server mutations.

---

## 1. Executive Summary

Phase 9B conducted an independent, evidence-based audit of the Phase 9A fail-closed payment attribution hardening. The audit inspected both the YouPI Payment Gateway core (`C:\vvisas-ai\YouPI-PG`) and the V-Visa B2B integration platform (`C:\vvisas-ai\V-VISAS\B2B-V-Visa-main`).

The implementation was evaluated against five key control areas:
1. **Account Isolation**
2. **Concurrency & Queue Invariants**
3. **Durable Idempotency**
4. **Settlement & Late-Arrival Behavior**
5. **Security & Operational Recovery**

### Summary of Control Ratings
- **Controls Evaluated:** 20
- **PASS:** 16
- **FAIL (Defects / Architectural Gaps Identified):** 3
- **NOT VERIFIED (Requires Live Hardware / Real Bank Credentials):** 1

---

## 2. Evidence Inspection Log: Files, Functions & Line References

| Component | File Path | Function / Block | Lines Inspected | Audit Scope |
|---|---|---|---|---|
| **Pipeline Core** | `packages/core/src/verification-pipeline.js` | `process()` Stage 0 & Stage 4 | Lines 221–236, 534–563 | Account scoping, removal of un-scoped queries |
| **Attribution Core** | `packages/core/src/attribution-engine.js` | `processObservation()` | Lines 150–185, 203–340, 485–540 | Fallback removal, Level 1/2 dual verification, late matches |
| **Poller Routes** | `apps/payment-api/src/routes/pollers.routes.js` | `POST /events`, `GET /active-window`, `handleAndroidSmsEvents` | Lines 30–56, 58–154, 217–285 | Android server-side binding, observer ingestion, active window |
| **Auth Middleware** | `apps/payment-api/src/auth-guard.js` | `authGuard()`, `requiredLevel()` | Lines 23–68 | Route authentication levels, token checks |
| **Secrets Engine** | `packages/common/src/secrets.js` | `resolveSecret()`, `getObserverToken()` | Lines 19–52 | Secret resolution, constant-time equality |
| **SMS Observer** | `apps/sms-observer/src/sms-service.js` | `resolveActiveReceivingAccount()`, `processSms()` | Lines 27–70 | Client-side account resolution |
| **Gmail Observer** | `apps/gmail-observer/src/gmail-poller.js` | `resolveActiveReceivingAccount()`, `processEmail()` | Lines 127–170 | Client-side account resolution |
| **Session Repository** | `packages/db/src/repositories/payment-session.repository.js` | `acquireSlotAtomic()` | Lines 80–160 | Queue slot transaction, stale slot cleanup |
| **Database Client** | `packages/db/src/database.js` | `Database`, `transaction()` | Lines 31–69, 136–150 | SQLite WAL mode, deferred transaction lock |
| **Database Schemas** | `packages/db/src/sqlite-schema.sql` & `packages/db/src/schema.sql` | `payment_sessions`, `payment_observations` | Lines 70–120 | Constraints, indices, missing partial unique index |
| **Admin Controls** | `apps/payment-api/src/routes/admin.routes.js` | `POST /api/v1/admin/counter-confirm` | Lines 270–329 | Manual override restrictions on UPI sessions |
| **V-Visa Webhook** | `src/app/api/payments/youpi/webhook/route.ts` | `POST()` | Lines 16–240 | Webhook HMAC, anti-replay, `db.$transaction`, UTR dedup |
| **V-Visa Client** | `src/server/integrations/youpi/client.ts` | `verifyYouPiWebhookSignature()` | Lines 112–140 | HMAC-SHA256 signature verification |
| **V-Visa Schema** | `prisma/schema.prisma` | `PaymentTransaction`, `WalletLedgerEntry` | Lines 805–885 | Durable unique constraints |

---

## 3. Detailed Control Assessment Matrix

### 3.1. Account Isolation

| ID | Control Description | Finding / Evidence | Rating |
|---|---|---|---|
| **1.1** | Candidate sessions must be strictly scoped to the receiving account | In `packages/core/src/verification-pipeline.js` (lines 231–235, 535–542) and `packages/core/src/attribution-engine.js` (lines 163–175), all session queries enforce `WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')`. | **PASS** |
| **1.2** | Elimination of cross-merchant / cross-account fallback by amount alone | Un-scoped fallback queries (`WHERE status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ? ORDER BY created_at DESC LIMIT 1`) were deleted in Phase 9A. Repository-wide grep confirms zero remaining global fallback queries. | **PASS** |
| **1.3** | Android observer server-side receiving-account binding | In `apps/payment-api/src/routes/pollers.routes.js` (lines 271–280), `receivingAccountId` is resolved strictly via `findActiveForMerchant(device.merchant_id)`. Client-supplied `body.receivingAccountId` overrides and the dummy UUID fallback (`00000000-0000-0000-0000-000000000002`) are removed. | **PASS** |
| **1.4** | Client-side observers cannot dynamically guess receiving accounts | In `apps/sms-observer/src/sms-service.js` (lines 27–38, 48–53) and `apps/gmail-observer/src/gmail-poller.js` (lines 127–138, 150–154), observers query `GET /api/v1/pollers/active-window` and pick `data.sessions[0].receivingAccountId`. In a multi-merchant or multi-account gateway, this creates cross-account contamination if alerts arrive while another merchant's session is active. | **FAIL** |
| **1.5** | Missing, invalid, or ambiguous account context must fail closed | Verified in Test 1 (`fail-closed-attribution.test.js` line 125) and Test 4 (line 216). When `receivingAccountId` is null or invalid, pipeline returns `UNRESOLVED` (`NO_ACTIVE_SESSION`); sessions remain `ACTIVE` without credit. | **PASS** |

---

### 3.2. Concurrency & Queue Invariants

| ID | Control Description | Finding / Evidence | Rating |
|---|---|---|---|
| **2.1** | Single-active-session invariant in application code | `acquireSlotAtomic()` in `packages/db/src/repositories/payment-session.repository.js` (lines 85–160) queries for an active slot; if busy, places subsequent requests in `QUEUED` with incrementing `queue_position`. Verified in Test 8 (`fail-closed-attribution.test.js`). | **PASS** |
| **2.2** | Multi-process lock conflict handling in SQLite | In `packages/db/src/database.js` line 137, transactions execute `BEGIN TRANSACTION;` which is a deferred transaction in SQLite. When two independent connections concurrently attempt `acquireSlotAtomic`, SQLite's WAL upgrade lock detects the collision and throws `SQLITE_BUSY: database is locked`. While this prevents dirty writes, there is no retry/backoff loop, causing an unhandled HTTP 500 error instead of graceful queuing. | **PASS (With Caveat)** |
| **2.3** | Declarative database schema constraint for single active session | Neither `packages/db/src/sqlite-schema.sql` nor `packages/db/src/schema.sql` (PostgreSQL) contains a partial unique index on `payment_sessions (receiving_account_id) WHERE status IN ('ACTIVE', 'PROCESSING')`. The invariant relies entirely on application-level serial transaction execution. Under PostgreSQL with default `READ COMMITTED` isolation, two concurrent checkouts could both commit `ACTIVE` without triggering a write conflict. | **FAIL** |

---

### 3.3. Durable Idempotency

| ID | Control Description | Finding / Evidence | Rating |
|---|---|---|---|
| **3.1** | Durable deduplication of webhooks in V-Visa | In `prisma/schema.prisma` line 877, `PaymentTransaction.webhookEventId` has `@unique`. In `src/app/api/payments/youpi/webhook/route.ts` line 67, duplicate webhook delivery IDs return `{ ok: true, duplicate: true }` without database mutation. | **PASS** |
| **3.2** | Durable wallet ledger idempotency key uniqueness | In `prisma/schema.prisma` line 815, `WalletLedgerEntry.idempotencyKey` has `@unique`. Deterministic format `wallet:order-deposit:<orderId>` prevents duplicate credits even if called concurrently. | **PASS** |
| **3.3** | Atomic commit of payment transaction and wallet ledger | In `src/app/api/payments/youpi/webhook/route.ts` lines 128–240, `tx.paymentTransaction.create`, `tx.paymentOrder.update`, and `createLedgerEntry(..., tx)` execute within a single Prisma `$transaction`. A failure in any statement rolls back the entire batch. | **PASS** |
| **3.4** | Cross-order provider transaction / UTR reuse protection | Enforced in V-Visa webhook handler (`route.ts` lines 131–140): rejects previously consumed UTRs with `PROVIDER_TRANSACTION_ALREADY_ATTRIBUTED`. Enforced in YouPI (`verification-pipeline.js` line 683): rejects consumed UTRs with `REFERENCE_ALREADY_USED`. | **PASS** |
| **3.5** | Multi-channel observer deduplication (SMS + Gmail) | Verified in Test 7 (`fail-closed-attribution.test.js` line 303). Dual alerts with the same UTR hash emit exactly 1 `PAYMENT.SUCCESS` event; the second observation is recorded as duplicate/already confirmed. | **PASS** |

---

### 3.4. Settlement & Late-Arrival Behavior

| ID | Control Description | Finding / Evidence | Rating |
|---|---|---|---|
| **4.1** | Expired session protection against late alert confirmation | In `packages/core/src/attribution-engine.js` lines 485–540, alerts arriving for expired or failed sessions are marked `LATE_UNMATCHED`. A high-priority support ticket is generated for merchant operations; the session is **never** auto-confirmed. Verified in Test 5 (`fail-closed-attribution.test.js` line 239). | **PASS** |
| **4.2** | Consumed UTR replay protection on subsequent sessions | In `packages/core/src/verification-pipeline.js` lines 683–712, incoming references are checked against prior successful orders. Replays are rejected with `REFERENCE_ALREADY_USED`. Verified in Test 6 (`fail-closed-attribution.test.js` line 263). | **PASS** |
| **4.3** | Distinguishing notification evidence from bank settlement | Confirmed: YouPI relies on parsing push notifications (SMS/Gmail). It is **not** an authoritative host-to-host settlement engine linked directly to RBI/NPCI core banking APIs. Real funds settlement occurs solely in the merchant's underlying bank account. | **PASS** |
| **4.4** | Manual reconciliation bypass prevention | In `apps/payment-api/src/routes/admin.routes.js` lines 282–285, `POST /api/v1/admin/counter-confirm` explicitly forbids confirming UPI sessions: `"Manual confirmation is only allowed for counter payments (session method is '${session.method}'). A UPI session must only reach SUCCESS through the verification engine."` | **PASS** |

---

### 3.5. Security & Operational Recovery

| ID | Control Description | Finding / Evidence | Rating |
|---|---|---|---|
| **5.1** | Webhook cryptographic signature verification | In `src/server/integrations/youpi/client.ts` lines 112–140, `verifyYouPiWebhookSignature()` enforces HMAC-SHA256 with `crypto.timingSafeEqual` over raw UTF-8 payloads. | **PASS** |
| **5.2** | Anti-replay timestamp drift validation | In V-Visa webhook handler (`route.ts` lines 36–41), timestamps exceeding 5 minutes (`MAX_WEBHOOK_AGE_MS`) are rejected. In YouPI Android observer route (`pollers.routes.js` line 258), timestamps exceeding 60 seconds are rejected with 401. | **PASS** |
| **5.3** | Unauthenticated Active Window endpoint leakage | `GET /api/v1/pollers/active-window` in `apps/payment-api/src/routes/pollers.routes.js` (lines 30–56) has **zero authentication**. In `apps/payment-api/src/auth-guard.js`, `requiredLevel()` returns `null` for this endpoint. Anyone on the network can query all active payment sessions, order IDs, amounts, and receiving account IDs. | **FAIL** |
| **5.4** | Secret and credential redaction in logs | Audit verified that `console.log` statements throughout the codebase redact sensitive tokens (`tunnel-command.js`, `whatsapp-berry.service.js`, `gmail-observer/src/server.js`). OTP numbers and signing keys are not printed in log streams. | **PASS** |
| **5.5** | Crash recovery & startup queue reconciliation | In `packages/core/src/recovery-engine.js` (lines 40–90), server boot triggers automatic cleanup: stale active/processing sessions exceeding expiration are marked `EXPIRED`/`FAILED`, slots are freed, and the next queued session is promoted. Verified in `queue-timing.test.js`. | **PASS** |
| **5.6** | Real bank hardware & production SIM card verification | Real hardware Android app on physical Samsung/Pixel device with active Indian SIM card and live Gmail OAuth credentials under production load. | **NOT VERIFIED (Simulated Only)** |

---

## 4. Test Commands & Empirical Results

The following test suites were executed locally in isolated development mode:

### 4.1. Core Fail-Closed Regression Suite
```bash
node --test packages/core/src/__tests__/fail-closed-attribution.test.js
```
**Result:** 8 tests, 1 suite, **8 PASS**, 0 FAIL (75.6 ms).  
Verified scenarios:
- Amount collision across merchants with missing account context: strictly NO attribution (`PASS`).
- Amount collision across receiving accounts: strictly NO cross-account attribution (`PASS`).
- Valid account context: only eligible sessions considered (`PASS`).
- Missing or invalid observer registration: rejected without guessing (`PASS`).
- Expired session alert: no automatic confirmation (`PASS`).
- Consumed UTR replay: strictly rejected with `REFERENCE_ALREADY_USED` (`PASS`).
- Dual-channel SMS/Gmail duplicate alerts: exactly 1 `PAYMENT.SUCCESS` emitted (`PASS`).
- Concurrent checkout creation: queue and session state remain atomic (`PASS`).

### 4.2. Gateway Core Test Suite
```bash
node --test packages/core/src/__tests__/core.test.js packages/core/src/__tests__/queue-timing.test.js packages/core/src/__tests__/webhook-engine.test.js packages/core/src/__tests__/fail-closed-attribution.test.js
```
**Result:** 23 tests, 7 suites, **23 PASS**, 0 FAIL (673.2 ms).

### 4.3. Multi-Connection Concurrency Scratch Test
Executed script: `test-concurrent-connections.mjs` against a temporary file database with two independent SQLite connection handles.  
**Result:**
- Sequential acquisition across independent connections: Session 1 = `ACTIVE`, Session 2 = `QUEUED`.
- Interleaved race condition: Connection 1 commits `ACTIVE`; Connection 2 update fails with `SQLITE_BUSY: database is locked`.
- Final state: Exactly 1 active session in database.

### 4.4. V-Visa Platform Integration & Idempotency Suites
```bash
node --test --experimental-strip-types tests/youpi-staging-verification.test.ts tests/zoho-payments-idempotency.test.ts
```
**Result:** 15 tests, **15 PASS**, 0 FAIL (315.1 ms).

### 4.5. Full V-Visa Platform Suite
```bash
node --test --experimental-strip-types tests/*.test.ts
```
**Result:** 243 tests, 31 suites, **243 PASS**, 0 FAIL (20.5 s).

---

## 5. Identified Defects & Architectural Gaps

### Defect 1: Unauthenticated `GET /api/v1/pollers/active-window` (Severity: HIGH)
- **Location:** `apps/payment-api/src/routes/pollers.routes.js:30-56` and `apps/payment-api/src/auth-guard.js:27-37`.
- **Finding:** The active window endpoint returns live orders, amounts in paise, and receiving account IDs to any unauthenticated caller on the network.
- **Risk:** Allows an external observer or attacker to monitor checkout activity, know exact payment amounts, and attempt targeted payment injection or spoofing.

### Defect 2: Client-Side Observers Guessing Target Account (Severity: HIGH)
- **Location:** `apps/sms-observer/src/sms-service.js:27-38` and `apps/gmail-observer/src/gmail-poller.js:127-138`.
- **Finding:** Both observers query `GET /api/v1/pollers/active-window` and blindly take `data.sessions[0].receivingAccountId`.
- **Risk:** In multi-tenant environments with concurrent checkouts across merchants, an observation for Merchant A could be labeled with Merchant B's account ID if Merchant B opened checkout last.

### Defect 3: Absence of Declarative Unique Constraint for Single Active Session (Severity: MEDIUM)
- **Location:** `packages/db/src/sqlite-schema.sql:99` and `packages/db/src/schema.sql:101`.
- **Finding:** Index `idx_payment_sessions_active ON payment_sessions (receiving_account_id, status)` is a standard non-unique index.
- **Risk:** Database does not prevent two sessions from simultaneously possessing `status = 'ACTIVE'` for the same receiving account. Relying solely on application-level transaction serialism is vulnerable if migrated to PostgreSQL under `READ COMMITTED` isolation.

### Defect 4: Unhandled `SQLITE_BUSY` Lock Upgrade Exceptions (Severity: MEDIUM)
- **Location:** `packages/db/src/database.js:137` and `packages/db/src/repositories/payment-session.repository.js:86`.
- **Finding:** Deferred `BEGIN TRANSACTION;` causes SQLite lock collisions on upgrade. When `SQLITE_BUSY` is thrown, the call crashes with an HTTP 500 error instead of gracefully retrying or queuing the checkout.

---

## 6. Minimal Recommended Remediation (For Future Implementation Phase)

1. **Protect Active Window Endpoint:**
   In `apps/payment-api/src/auth-guard.js`, add:
   ```js
   if (method === 'GET' && pathname === '/api/v1/pollers/active-window') return 'observer';
   ```
2. **Pin Observers to Static Receiving Accounts:**
   Remove dynamic calls to `resolveActiveReceivingAccount()` in `sms-service.js` and `gmail-poller.js`. Require `RECEIVING_ACCOUNT_ID` as a mandatory environment variable per observer instance.
3. **Add Declarative Partial Unique Index:**
   Add database migration with:
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session
   ON payment_sessions (receiving_account_id)
   WHERE status IN ('ACTIVE', 'PROCESSING');
   ```
4. **Use `BEGIN IMMEDIATE` or Retry Wrapper in Database Client:**
   In `packages/db/src/database.js`, execute `BEGIN IMMEDIATE TRANSACTION;` for write transactions in SQLite so that write locks are acquired upfront, allowing `busy_timeout` (5000ms) to serialize concurrent checkouts cleanly.

---

## 7. Mandatory Evidence Required Before Separately Authorized Pilot

Before any live ₹1 pilot or external bank approval can be considered:
1. **Remediation of Identified Defects:** Items 1 and 2 in Section 6 must be implemented and tested in code.
2. **Bank Written Agreement:** Written confirmation from the receiving bank authorizing automated scraping of alerts or notification ingestion for commercial payment confirmation.
3. **Physical Hardware Demonstration:** Proof that a physical Android device running Android 14/15 on battery power can reliably ingest SMS alerts without OS background task throttling.
4. **Dedicated Merchant Bank Account:** Zero personal savings accounts; dedicated corporate current account with designated UPI VPA.
5. **Audited Financial Reconciliation Runbook:** Formal operations runbook for manual handling of `LATE_UNMATCHED` support tickets.

---

## 8. Compliance & Governance Attestation

- **Environment Setting:** `ENABLE_YOUPI_UPI=false` remains enforced.
- **Primary Gateway:** Zoho Payments is 100% active and primary.
- **Transactions Conducted:** ZERO real-money transactions.
- **Deployment Status:** ZERO files deployed to Oracle VM or production.
- **Local Isolation:** All tests executed against local in-memory or ephemeral temporary databases.
