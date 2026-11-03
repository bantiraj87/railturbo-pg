# YouPI Phase 9C — Observer Isolation and Concurrency Hardening Report

**Phase:** Phase 9C — Remediation and Verification  
**Date:** October 19, 2026  
**Auditor / Implementer:** Antigravity Engineering  
**Status:** COMPLETE — ALL REMEDIATIONS VERIFIED & ALL 34 TEST SUITES PASSING  

---

## 1. Executive Summary

During the Phase 9B Read-Only Audit, four critical vulnerabilities and concurrency hazards were identified in the observer intake and payment session lifecycle of YouPI-PG:
1. **Unprotected Active-Window Route**: `GET /api/v1/pollers/active-window` leaked payment sessions across all merchants without authentication.
2. **Dynamic Account Guessing in Observers**: `SmsObserverService` and `GmailPoller` queried `active-window` and adopted `sessions[0].receivingAccountId`, creating cross-wiring risks.
3. **Missing DB Constraint for Single Active Session**: The single-active-session invariant was enforced only in application code, vulnerable to race conditions.
4. **SQLite Concurrency Lock Contention**: Default deferred transactions caused `SQLITE_BUSY: database is locked` collisions during concurrent checkouts.

In **Phase 9C**, all four findings have been remediated in source code, enforced at the database schema level, and verified with dedicated synthetic test suites.

### Strict Governance & Boundary Adherence
- **Zero Live Credentials**: No real bank accounts, VPAs, or live observer credentials used or created.
- **Zero Real Devices**: No physical Android hardware enrolled; no live Gmail OAuth tokens requested.
- **Zero Money Transferred**: 100% of testing performed with synthetic in-memory databases and isolated test ports.
- **Platform Invariants Frozen**: V-Visa platform remains with `ENABLE_YOUPI_UPI=false`. Zoho Payments remains 100% primary and fully untouched.
- **Full Suite Integrity**:
  - `YouPI-PG`: **34 / 34 test suites PASS** (100% clean, 48.42s).
  - `V-Visa B2B`: **243 / 243 tests PASS** (31 test suites, 0 failures, 19.65s).

---

## 2. Technical Remediation Matrix

| Finding ID | Vulnerability | Remediation Applied | Files Modified | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| **Fix 1** | Anonymous `active-window` route leaking all sessions | Protected route behind `requiredLevel = 'observer'` in `auth-guard.js`. Strictly scoped sessions to the observer's registered `receivingAccountId`. Added anti-spoofing checks rejecting cross-merchant/cross-account queries with `403`. | `apps/payment-api/src/auth-guard.js`<br>`apps/payment-api/src/routes/pollers.routes.js` | **VERIFIED PASS**<br>(Tests 1.1–1.7 in `observer-isolation-concurrency.test.js`) |
| **Fix 2** | Dynamic account guessing (`sessions[0]`) in SMS & Gmail observers | Deleted `resolveActiveReceivingAccount()` from both observer services. Enforced explicit `receivingAccountId` binding via constructor options or `RECEIVING_ACCOUNT_ID` environment variable. Fails closed immediately (returns `null` with 0 observations) if unconfigured. | `apps/sms-observer/src/sms-service.js`<br>`apps/gmail-observer/src/gmail-poller.js` | **VERIFIED PASS**<br>(Tests 2.1–2.2 in `observer-isolation-concurrency.test.js`) |
| **Fix 3** | Application-only single-active-session invariant | Added declarative partial unique index `idx_single_active_session` on `payment_sessions (receiving_account_id) WHERE status IN ('ACTIVE', 'PROCESSING')` in SQLite and PostgreSQL schemas. Added migration preflight conflict checks. Updated `acquireSlotAtomic` to gracefully catch collisions and queue sessions. | `packages/db/src/sqlite-schema.sql`<br>`packages/db/src/schema.sql`<br>`packages/db/src/migrate.js`<br>`packages/db/src/repositories/payment-session.repository.js` | **VERIFIED PASS**<br>(Tests 3.1–3.3 in `observer-isolation-concurrency.test.js`) |
| **Fix 4** | SQLite `SQLITE_BUSY` lock contention during concurrent checkouts | Upgraded `Database.transaction` to use `BEGIN IMMEDIATE TRANSACTION;` by default, acquiring write locks upfront. Added `withRetry` utility with bounded exponential backoff and randomized jitter for transient lock contention. | `packages/db/src/database.js`<br>`packages/db/src/repositories/payment-session.repository.js` | **VERIFIED PASS**<br>(Tests 4.1–4.2 in `observer-isolation-concurrency.test.js`) |

---

## 3. Deep-Dive Remediation Analysis

### Fix 1: Active-Window Route Protection & Scoping

#### The Vulnerability
`GET /api/v1/pollers/active-window` returned an array of all active payment sessions across the entire database without any authentication header or merchant scoping. Any caller could enumerate active transaction amounts and order IDs across all merchants.

#### The Remediation
1. **Auth Guard Protection (`apps/payment-api/src/auth-guard.js`)**:
   - Registered `GET /api/v1/pollers/active-window` under `requiredLevel = 'observer'`.
   - Allows requests bearing a valid observer bearer token (`OBSERVER_API_TOKEN`), admin token, or registered Android device header (`X-Device-Id`).
   - Unauthenticated or invalid token requests are halted with HTTP 401 `AUTH_REQUIRED`.
2. **Authorized Scope Filtering (`apps/payment-api/src/routes/pollers.routes.js`)**:
   - **Android Device Ingestion**: Resolves device from `android_devices` where `is_active = 1`. Scopes query strictly to the active receiving account of the device's merchant. Cross-account override attempts return HTTP 403 `CROSS_ACCOUNT_FORBIDDEN`.
   - **Observer Bearer Token**: Requires mandatory `receivingAccountId` query parameter or header. Rejects missing account binding with HTTP 400 `ACCOUNT_BINDING_REQUIRED`.
   - **Cross-Merchant Isolation**: Validates that `receivingAccountId` belongs to the requesting merchant. If `merchantId` is provided and does not match the account's merchant, returns HTTP 403 `MERCHANT_ACCOUNT_MISMATCH`.
   - **Filtered Result Set**: Database query executes `WHERE receiving_account_id = ?`, returning only sessions for the authorized account.

---

### Fix 2: Elimination of Account Guessing in Observers

#### The Vulnerability
`apps/sms-observer/src/sms-service.js` and `apps/gmail-observer/src/gmail-poller.js` implemented `resolveActiveReceivingAccount()`:
```javascript
// FORMER INSECURE IMPLEMENTATION
async resolveActiveReceivingAccount() {
  const res = await fetch(`${this.apiBaseUrl}/api/v1/pollers/active-window`);
  const data = await res.json();
  if (data.sessions?.length > 0) return data.sessions[0].receivingAccountId;
  return null;
}
```
If a customer checked out under Merchant B while an SMS arrived for Merchant A, the observer would adopt Merchant B's account ID and misattribute the transaction.

#### The Remediation
1. **Complete Deletion**: Removed `resolveActiveReceivingAccount()` from both `sms-service.js` and `gmail-poller.js`.
2. **Mandatory Configuration**: Observers require explicit `receivingAccountId` provided in constructor options or via `process.env.RECEIVING_ACCOUNT_ID`. Defaults to `null` if unconfigured.
3. **Fail-Closed Processing**:
   - In `processSms()` and `processEmail()`:
     ```javascript
     if (!this.receivingAccountId) {
       console.warn('[Observer] Dropping observation: no receivingAccountId configured (fail-closed, dynamic guessing prohibited)');
       return null;
     }
     ```
   - Observations are discarded without network calls, without database writes, and without account guessing.

---

### Fix 3: Single-Active-Session Database Invariant

#### The Vulnerability
The invariant that "a receiving account has at most ONE active session" was enforced only via application-level check-and-insert in JavaScript. Two concurrent checkout HTTP requests could simultaneously read "no active sessions" before either wrote to the database, resulting in two concurrent `ACTIVE` sessions for the same VPA.

#### The Remediation
1. **Declarative Partial Unique Index**:
   - Added to SQLite (`packages/db/src/sqlite-schema.sql`):
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session 
     ON payment_sessions (receiving_account_id) 
     WHERE status IN ('ACTIVE', 'PROCESSING');
     ```
   - Added to PostgreSQL (`packages/db/src/schema.sql`):
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session 
     ON payment_sessions (receiving_account_id) 
     WHERE status IN ('ACTIVE', 'PROCESSING');
     ```
2. **Preflight Migration Protection (`packages/db/src/migrate.js`)**:
   - Prior to creating the index, a preflight validation checks whether any account already violates the invariant. If duplicate active sessions exist, migration throws an explicit error rather than silently failing or corrupting data.
3. **Atomic Slot Acquisition Handling (`packages/db/src/repositories/payment-session.repository.js`)**:
   - `acquireSlotAtomic(sessionId, receivingAccountId, durationMs)` wraps the slot acquisition.
   - If a concurrent checkout races past the initial SELECT and triggers a uniqueness violation on `idx_single_active_session`, `acquireSlotAtomic` catches the error and cleanly transitions the competing session to `QUEUED` with its calculated queue position, returning a graceful response instead of an HTTP 500 error.

---

### Fix 4: SQLite Contention Handling & Immediate Transactions

#### The Vulnerability
SQLite's default transaction mode (`BEGIN TRANSACTION;`) is `DEFERRED`. In multi-process or concurrent async operations, two transactions can acquire shared read locks. When both attempt to write (`INSERT` / `UPDATE`), SQLite cannot upgrade either lock without causing a deadlock, immediately throwing `SQLITE_BUSY: database is locked`.

#### The Remediation
1. **Immediate Write Locking (`packages/db/src/database.js`)**:
   - Upgraded `Database.transaction(callback, options)`:
     ```javascript
     const mode = (options.mode || 'IMMEDIATE').toUpperCase();
     this.db.exec(`BEGIN ${mode} TRANSACTION;`);
     ```
   - Using `BEGIN IMMEDIATE TRANSACTION;` acquires write intent at the start of the transaction. Other writers wait on the SQLite `busy_timeout` (5000ms) rather than colliding on upgrade.
2. **Exponential Backoff Retry (`Database.withRetry`)**:
   - Added `isRetryableSqliteError(err)` detecting `SQLITE_BUSY`, `SQLITE_LOCKED`, and `"database is locked"`.
   - Added `withRetry(operation, maxRetries = 3, baseDelayMs = 50)`:
     - Catches retryable lock contention.
     - Retries with exponential backoff: $delay = \min(baseDelay \cdot 2^{attempt - 1}, 500) + jitter$.
     - If retries are exhausted, throws a typed `DatabaseBusyError`.
3. **Queue Promotion Wrapping**:
   - Wrapped critical write paths (`acquireSlotAtomic`, `promoteNext`) with `withRetry`.

---

## 4. Verification Evidence & Test Execution

### 1. Dedicated Phase 9C Suite (`packages/core/src/__tests__/observer-isolation-concurrency.test.js`)
```
[Payment API] Server listening on port 6198
▶ Phase 9C: Observer Isolation & Concurrency Hardening Suite
  ✔ Fix 1.1: GET /api/v1/pollers/active-window without credentials returns 401 (50.21ms)
  ✔ Fix 1.2: GET /api/v1/pollers/active-window with invalid token returns 401 (5.49ms)
  ✔ Fix 1.3: Observer token without receivingAccountId returns 400 ACCOUNT_BINDING_REQUIRED (4.71ms)
  ✔ Fix 1.4: Observer token querying non-existent account returns 403 INVALID_RECEIVING_ACCOUNT (5.42ms)
  ✔ Fix 1.5: Observer token with mismatched merchantId returns 403 MERCHANT_ACCOUNT_MISMATCH (6.61ms)
  ✔ Fix 1.6: Observer query returns ONLY sessions scoped to the authorized receiving account (21.39ms)
  ✔ Fix 1.7: Android observer device authentication scopes to merchant account and prevents spoofing (17.86ms)
  ✔ Fix 2.1: SmsObserverService without receivingAccountId fails closed without guessing (0.95ms)
  ✔ Fix 2.2: GmailPoller without receivingAccountId fails closed without guessing (0.55ms)
  ✔ Fix 3.1: Database unique index idx_single_active_session rejects 2nd ACTIVE session on same account (1.52ms)
  ✔ Fix 3.2: Concurrent ACTIVE sessions on DIFFERENT receiving accounts are permitted (0.77ms)
  ✔ Fix 3.3: acquireSlotAtomic queues 2nd request gracefully when slot is occupied (1.21ms)
  ✔ Fix 4.1: Concurrent acquireSlotAtomic race results in 1 ACTIVE and remaining QUEUED with 0 errors (1.47ms)
  ✔ Fix 4.2: Database withRetry retries transient busy operations successfully (51.73ms)
✔ Phase 9C: Observer Isolation & Concurrency Hardening Suite (199.25ms)
ℹ tests 14
ℹ suites 1
ℹ pass 14
ℹ fail 0
```

### 2. Full Regression Test Runner (`YouPI-PG: npm test`)
```
============================================================
🧪 YOUPI PG V2 — FULL REGRESSION TEST RUNNER
Running 34 curated test suites...
============================================================

[1/34] Testing packages/common/src/__tests__/common.test.js... ✅ PASS (0.44s)
[2/34] Testing packages/db/src/__tests__/customer-reset.test.js... ✅ PASS (0.28s)
[3/34] Testing packages/db/src/__tests__/auth-matrix.test.js... ✅ PASS (11.20s)
[4/34] Testing packages/db/src/__tests__/db.test.js... ✅ PASS (0.50s)
[5/34] Testing packages/core/src/__tests__/core.test.js... ✅ PASS (0.42s)
[6/34] Testing packages/core/src/__tests__/fail-closed-attribution.test.js... ✅ PASS (0.28s)
[7/34] Testing packages/core/src/__tests__/observer-isolation-concurrency.test.js... ✅ PASS (0.54s)
[8/34] Testing packages/core/src/__tests__/queue-timing.test.js... ✅ PASS (0.40s)
[9/34] Testing packages/core/src/__tests__/webhook-engine.test.js... ✅ PASS (0.42s)
[10/34] Testing packages/merchant-sdk/src/__tests__/merchant-sdk.test.js... ✅ PASS (0.43s)
[11/34] Testing packages/merchant-sdk/src/__tests__/youpi-universal-integration.test.js... ✅ PASS (1.85s)
[12/34] Testing apps/checkout-portal/src/__tests__/checkout-portal.test.js... ✅ PASS (0.48s)
[13/34] Testing apps/coin-wallet-store/src/__tests__/coin-wallet-store.test.js... ✅ PASS (0.54s)
[14/34] Testing apps/merchant-admin/src/__tests__/merchant-admin.test.js... ✅ PASS (0.41s)
[15/34] Testing apps/payment-help/src/__tests__/payment-help.test.js... ✅ PASS (0.35s)
[16/34] Testing apps/gmail-observer/src/__tests__/gmail-observer.test.js... ✅ PASS (0.46s)
[17/34] Testing apps/sms-observer/src/__tests__/sms-observer.test.js... ✅ PASS (0.44s)
[18/34] Testing apps/android-observer-app/__tests__/android-observer.test.js... ✅ PASS (0.44s)
[19/34] Testing apps/control-center/src/__tests__/control-center.test.js... ✅ PASS (0.29s)
[20/34] Testing apps/payment-api/src/__tests__/payment-api.test.js... ✅ PASS (5.82s)
[21/34] Testing apps/payment-api/src/__tests__/auth-guard.test.js... ✅ PASS (0.65s)
[22/34] Testing apps/payment-api/src/__tests__/counter-payments.test.js... ✅ PASS (0.41s)
[23/34] Testing apps/payment-api/src/__tests__/selling-modes-and-cod.test.js... ✅ PASS (0.43s)
[24/34] Testing apps/payment-api/src/__tests__/developer-payment-simulator.test.js... ✅ PASS (0.54s)
[25/34] Testing apps/payment-api/src/__tests__/developer-test-mode.test.js... ✅ PASS (0.41s)
[26/34] Testing apps/payment-api/src/__tests__/device-binding-duplicate-session.test.js... ✅ PASS (0.50s)
[27/34] Testing apps/payment-api/src/__tests__/fraud-ban-pipeline.test.js... ✅ PASS (0.46s)
[28/34] Testing apps/payment-api/src/__tests__/sms-gmail-verification-levels.test.js... ✅ PASS (3.57s)
[29/34] Testing apps/payment-api/src/__tests__/upi-server-health-and-pc-ui.test.js... ✅ PASS (0.46s)
[30/34] Testing apps/payment-api/src/__tests__/whatsapp-berry-auth.test.js... ✅ PASS (13.23s)
[31/34] Testing apps/payment-api/src/__tests__/whitelabel-branding.test.js... ✅ PASS (0.51s)
[32/34] Testing apps/payment-api/src/__tests__/cod-parallel-timer-decoupling.test.js... ✅ PASS (0.50s)
[33/34] Testing scripts/chaos-concurrency.test.js... ✅ PASS (0.39s)
[34/34] Testing scripts/production-infrastructure.test.js... ✅ PASS (0.38s)

============================================================
🎉 ALL 34 TEST SUITES PASSED CLEANLY (Total: 48.42s)
============================================================
```

### 3. V-Visa Platform Test Runner (`V-VISAS/B2B-V-Visa-main: npm test`)
```
ℹ tests 243
ℹ suites 31
ℹ pass 243
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19655.4636
```

---

## 5. Security & Isolation Invariants Confirmed

1. **Information Disclosure Neutralized**:
   - Unauthenticated access to `GET /api/v1/pollers/active-window` is permanently closed.
   - Observer requests cannot inspect active sessions outside their explicit receiving account and merchant context.
2. **Cross-Tenant Attribution Prohibited**:
   - Fallback attribution by amount alone is impossible across accounts or merchants.
   - Dynamic account adoption via `sessions[0]` has been completely excised from all observer code.
   - Unconfigured observers fail closed immediately without creating phantom observations.
3. **Database-Level Invariant Guarantee**:
   - Two concurrent checkouts on the same VPA cannot both achieve `ACTIVE` status.
   - SQLite and PostgreSQL reject violating inserts at the index engine level.
   - Colliding requests are seamlessly queued with deterministic ordering.
4. **Resilient Under Contention**:
   - `BEGIN IMMEDIATE` prevents shared-lock escalation deadlocks.
   - Bounded exponential retries ensure that bursts of concurrent checkouts resolve smoothly without throwing 500 errors.

---

## 6. Conclusion & Current Release Readiness

Phase 9C has successfully resolved all architectural, security, and concurrency findings identified in Phase 9B. The payment processing engine is hardened both logically in application code and physically at the database constraint layer.

The integration remains safely quarantined:
- Staging and production configurations remain frozen.
- Feature flag `ENABLE_YOUPI_UPI=false` remains enforced.
- Zoho Payments continues operating as the sole active payment processor for V-Visa B2B.
- Full regression evidence is preserved and reproducible on demand.
