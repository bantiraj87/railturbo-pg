# YouPI-PG Phase 9D — Release-Candidate Verification Dossier

**Status**: VERIFIED RELEASE-CANDIDATE  
**Evaluation Date**: 2026-10-19  
**Upstream Commit**: `560037147b5dcdc3620ee4efa40c5fff2496a418`  
**YouPI Test Suite**: 35/35 PASSED (38.25s)  
**V-Visa Test Suite**: 243/243 PASSED (19.80s)  
**Production Enforcement**: `ENABLE_YOUPI_UPI=false` strictly preserved; Zoho Payments remains primary.

---

## Executive Summary

Phase 9D provides independent, empirical verification that the concurrency, observer isolation, and fail-closed attribution remediations delivered in Phase 9C are production-safe to migrate, deploy, and operate before any pilot authorization is requested.

Across five targeted verification dimensions, the implementation was rigorously tested with synthetic workloads and failure injection:
1. **Migration Safety**: Both PostgreSQL and SQLite partial unique indexes (`idx_single_active_session`) are declared with identical semantics. The migration runner (`packages/db/src/migrate.js`) executes a mandatory preflight inspection that cleanly halts with an explicit error if duplicate active sessions exist, preventing database corruption or cryptic engine crashes.
2. **Observer Provisioning Binding**: Observation intake endpoints enforce server-side device authentication (`android_devices`), verifying that device ownership matches receiving-account merchant ownership. Dynamic account guessing in SMS and Gmail observers has been permanently eliminated; observers without a server-configured `receivingAccountId` fail closed with zero network transmissions.
3. **Transaction & Retry Safety**: SQLite transactions support arbitrary nesting via `SAVEPOINT sp_<depth>` semantics. Contention retries distinguish retryable lock errors from terminal constraint violations; persistent lock exhaustion throws a typed `DatabaseBusyError`.
4. **End-to-End Payment Integrity**: A full synthetic lifecycle from checkout session creation to observation attribution, status transition, and HMAC SHA-256 webhook generation executed cleanly. Delivery replay tests prove the platform ledger rejects duplicate deliveries without double-crediting.
5. **Operational Recovery & Stale Sweeps**: System reboot cleanly triggers `RecoveryEngine.recover()`, transitioning expired unverified sessions to `EXPIRED` and releasing the receiving account slot for subsequent transactions.

---

## Verification Results Summary

| Verification Dimension | Focus Area | Automated Test Coverage | Verification Result |
| :--- | :--- | :--- | :--- |
| **Check 1: Migration Safety** | Preflight conflict stop & SQLite/PostgreSQL schema parity | `release-candidate-verification.test.js` (1.1, 1.2)<br>`db.test.js` | **PASS (VERIFIED)** |
| **Check 2: Observer Isolation** | Trusted server registration, device authentication & account binding | `release-candidate-verification.test.js` (2.1, 2.2, 2.3, 2.4)<br>`auth-guard.test.js` | **PASS (VERIFIED)** |
| **Check 3: Transaction Safety** | Savepoint nesting, non-retryable constraint halts, `DatabaseBusyError` | `release-candidate-verification.test.js` (3.1, 3.2, 3.3, 3.4)<br>`chaos-concurrency.test.js` | **PASS (VERIFIED)** |
| **Check 4: E2E Payment Integrity** | Synthetic order lifecycle, HMAC webhook signing & replay protection | `release-candidate-verification.test.js` (4.1, 4.2)<br>`webhook-engine.test.js` | **PASS (VERIFIED)** |
| **Check 5: Deployment & Recovery** | Stale session sweep, boot recovery, and runbook definitions | `release-candidate-verification.test.js` (5.1)<br>`production-infrastructure.test.js` | **PASS (VERIFIED)** |

---

## Detailed Check Analysis

### Check 1: Migration Correctness & Safe Stop

#### 1. Schema Parity
Both the SQLite and PostgreSQL schemas declare the exact partial unique index enforcing one active/processing session per receiving account:

- **SQLite Schema** (`packages/db/src/sqlite-schema.sql` L100):
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session 
  ON payment_sessions (receiving_account_id) 
  WHERE status IN ('ACTIVE', 'PROCESSING');
  ```
- **PostgreSQL Schema** (`packages/db/src/schema.sql` L125):
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session 
  ON payment_sessions (receiving_account_id) 
  WHERE status IN ('ACTIVE', 'PROCESSING');
  ```

#### 2. Conflict Preflight Halting
In `packages/db/src/migrate.js`, the preflight conflict check runs *prior* to DDL execution:
```javascript
const conflictingAccounts = db.query(`
  SELECT receiving_account_id, COUNT(*) as active_count
  FROM payment_sessions
  WHERE status IN ('ACTIVE', 'PROCESSING')
  GROUP BY receiving_account_id
  HAVING active_count > 1
`);

if (conflictingAccounts && conflictingAccounts.length > 0) {
  const accountList = conflictingAccounts.map(a => `${a.receiving_account_id} (${a.active_count} sessions)`).join(', ');
  throw new Error(`[migrate] Cannot apply idx_single_active_session: Detected ${conflictingAccounts.length} receiving account(s) with multiple active/processing sessions: ${accountList}. Expire or resolve these sessions before running migration.`);
}
```
**Empirical Verification**:
- Test 1.1 seeded an existing database with two simultaneous active sessions on account `acc_preflight_1`.
- Running `runMigrations(db)` immediately threw: `[migrate] Cannot apply idx_single_active_session: Detected 1 receiving account(s) with multiple active/processing sessions...`
- Resolving the duplicate session allowed the migration to proceed and successfully create `idx_single_active_session`.

---

### Check 2: Observer Provisioning & Server Registration Binding

#### 1. Intake Endpoint Scoping (`POST /api/v1/pollers/events`)
The ingestion router (`apps/payment-api/src/routes/pollers.routes.js`) performs strict server-side validation on every observation:
1. **Device Authentication**: If `X-Device-Id` is provided (Android observer), the system queries the `android_devices` table. If the device does not exist or `is_active !== 1`, it immediately returns HTTP 403 `DEVICE_UNAUTHORIZED`.
2. **Device-to-Merchant Binding**: If the device belongs to Merchant A, but the observation payload targets a receiving account belonging to Merchant B, it rejects with HTTP 403 `CROSS_ACCOUNT_FORBIDDEN`.
3. **Merchant Scope Validation**: If `X-Merchant-Id` is provided, it must match `receivingAccount.merchant_id`; otherwise, it returns HTTP 403 `MERCHANT_ACCOUNT_MISMATCH`.

#### 2. Fail-Closed Dynamic Guessing Prohibition
- In `apps/sms-observer/src/sms-observer.service.js` and `apps/gmail-observer/src/gmail-poller.js`, observations without an explicit server-provisioned `receivingAccountId` are dropped at the source:
  ```
  [SMS Observer] Dropping observation: no receivingAccountId configured (fail-closed, dynamic guessing prohibited)
  [Gmail Observer] Dropping observation: no receivingAccountId configured (fail-closed, dynamic guessing prohibited)
  ```
- Verified that 0 network requests are dispatched and 0 observations are recorded when unconfigured.

---

### Check 3: Transaction & Retry Safety

#### 1. SQLite Savepoints for Nested Transactions
In `packages/db/src/database.js`, the transaction wrapper tracks connection nesting depth:
```javascript
transaction(fn) {
  if (this.transactionDepth > 0) {
    this.transactionDepth++;
    const savepointName = `sp_${this.transactionDepth}`;
    this.execute(`SAVEPOINT ${savepointName}`);
    try {
      const result = fn();
      this.execute(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (err) {
      this.execute(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }
  // Outer transaction uses BEGIN / COMMIT / ROLLBACK
  ...
}
```
**Empirical Verification**:
- Test 3.1: Nested transaction executed inner operations; outer transaction committed cleanly.
- Test 3.2: Inner transaction threw and rolled back to its savepoint. The outer transaction caught the error, wrote additional audit rows, and committed. The inner rolled-back row was absent while outer rows persisted.

#### 2. Retry Boundaries & Error Classification
In `packages/db/src/database.js`, `withRetry(fn, maxRetries, delayMs)` checks `isRetryableError(err)`:
- `SQLITE_BUSY` or `SQLITE_LOCKED` -> `isRetryable = true` (retried with exponential backoff).
- `SQLITE_CONSTRAINT` (e.g. `idx_single_active_session` or unique key) -> `isRetryable = false`.
- **Empirical Verification**:
  - Test 3.3: A UNIQUE constraint error failed immediately on attempt 1 without retrying.
  - Test 3.4: Under persistent lock exhaustion (4 attempts), `DatabaseBusyError` was thrown with `err.code = 'DATABASE_BUSY'` and `err.isRetryable = true`.

---

### Check 4: End-to-End Payment Integrity & Anti-Replay

#### 1. Full Payment Lifecycle Trace
1. **Order Checkout**: Payment session `ORD_E2E_9D_01` created in `ACTIVE` state with 25,000 paise (₹250.00).
2. **Observation Ingest**: SMS bank observation parsed for ₹250.00 with UTR `998877665544`.
3. **Attribution Engine**: Matched `ORD_E2E_9D_01` based on receiving account, amount match, and temporal slot window.
4. **State Transition**: Session transitioned atomically from `ACTIVE` to `SUCCESS`.
5. **Signed Webhook Dispatch**: Payload generated with HMAC SHA-256 signature using the merchant's secret:
   - Signature: `sha256=<hex_digest>`
   - Tampered signature test verified safe rejection.

#### 2. Webhook Replay & Duplicate Ledger Credit Protection
- In V-Visa (`src/server/wallet/service.ts`), every deposit derives an idempotent ledger key:
  `youpi:deposit:<paymentId>`
- Simulated duplicate webhook deliveries confirmed that subsequent deliveries detect the existing ledger record and return duplicate acknowledgement without incrementing balance.

---

### Check 5: Deployment, Monitoring, and Recovery Runbook

#### 1. Safe Deployment & Migration Order
When staging or production deployment is eventually authorized:
1. **Pre-Deployment Inspection**:
   Run preflight query against the database:
   ```sql
   SELECT receiving_account_id, COUNT(*) as active_count
   FROM payment_sessions
   WHERE status IN ('ACTIVE', 'PROCESSING')
   GROUP BY receiving_account_id
   HAVING active_count > 1;
   ```
   If rows return, execute session resolution script before starting service.
2. **Deploy Database Migration**:
   Run `npm run migrate`. The migration script safely verifies zero conflicts before creating `idx_single_active_session`.
3. **Deploy Payment API & Core Engines**:
   Start YouPI core services. `RecoveryEngine.recover()` automatically sweeps stale sessions.
4. **Deploy Observers**:
   Provision observers with registered device IDs and explicit `RECEIVING_ACCOUNT_ID`.

#### 2. Rollback Considerations
- If rolling back from Phase 9D, dropping the partial unique index:
  ```sql
  DROP INDEX IF EXISTS idx_single_active_session;
  ```
  is non-destructive and requires zero data modification or column drops.
- Downward migration does not risk ledger corruption since `PaymentTransaction` idempotency constraints remain enforced at the V-Visa application level.

#### 3. Monitoring & Alerting Metrics

| Metric Name | Threshold / Condition | Recommended Action |
| :--- | :--- | :--- |
| `youpi_active_slot_duration_seconds` | `> 600s` (10 minutes) | Inspect recovery engine; release stuck session |
| `youpi_unmatched_observations_total` | Rate `> 5 / min` | Verify observer bank parsing and account configuration |
| `youpi_db_busy_retries_total` | Rate `> 10 / min` | Check SQLite WAL mode and busy timeout settings |
| `youpi_observer_heartbeat_age_seconds` | `> 120s` (2 minutes) | Alert on Android observer network or battery sleep |

---

## Complete Test Suite Verification

### 1. YouPI-PG Gateway Suite
Command: `npm test`  
Location: `C:\vvisas-ai\YouPI-PG`  
Result: **35/35 Suites Passed** (Total runtime: 38.25s)

```
[1/35] packages/common/src/__tests__/common.test.js... ✅ PASS (0.38s)
[2/35] packages/db/src/__tests__/customer-reset.test.js... ✅ PASS (0.23s)
[3/35] packages/db/src/__tests__/auth-matrix.test.js... ✅ PASS (11.32s)
[4/35] packages/db/src/__tests__/db.test.js... ✅ PASS (0.47s)
[5/35] packages/core/src/__tests__/core.test.js... ✅ PASS (0.37s)
[6/35] packages/core/src/__tests__/fail-closed-attribution.test.js... ✅ PASS (0.37s)
[7/35] packages/core/src/__tests__/observer-isolation-concurrency.test.js... ✅ PASS (0.59s)
[8/35] packages/core/src/__tests__/release-candidate-verification.test.js... ✅ PASS (0.48s)
[9/35] packages/core/src/__tests__/queue-timing.test.js... ✅ PASS (0.44s)
[10/35] packages/core/src/__tests__/webhook-engine.test.js... ✅ PASS (0.38s)
[11/35] packages/merchant-sdk/src/__tests__/merchant-sdk.test.js... ✅ PASS (0.39s)
[12/35] packages/merchant-sdk/src/__tests__/youpi-universal-integration.test.js... ✅ PASS (1.81s)
[13/35] apps/checkout-portal/src/__tests__/checkout-portal.test.js... ✅ PASS (0.42s)
[14/35] apps/coin-wallet-store/src/__tests__/coin-wallet-store.test.js... ✅ PASS (0.51s)
[15/35] apps/merchant-admin/src/__tests__/merchant-admin.test.js... ✅ PASS (0.37s)
[16/35] apps/payment-help/src/__tests__/payment-help.test.js... ✅ PASS (0.36s)
[17/35] apps/gmail-observer/src/__tests__/gmail-observer.test.js... ✅ PASS (0.45s)
[18/35] apps/sms-observer/src/__tests__/sms-observer.test.js... ✅ PASS (0.46s)
[19/35] apps/android-observer-app/__tests__/android-observer.test.js... ✅ PASS (0.44s)
[20/35] apps/control-center/src/__tests__/control-center.test.js... ✅ PASS (0.26s)
[21/35] apps/payment-api/src/__tests__/payment-api.test.js... ✅ PASS (5.66s)
[22/35] apps/payment-api/src/__tests__/auth-guard.test.js... ✅ PASS (0.64s)
[23/35] apps/payment-api/src/__tests__/counter-payments.test.js... ✅ PASS (0.41s)
[24/35] apps/payment-api/src/__tests__/selling-modes-and-cod.test.js... ✅ PASS (0.40s)
[25/35] apps/payment-api/src/__tests__/developer-payment-simulator.test.js... ✅ PASS (0.47s)
[26/35] apps/payment-api/src/__tests__/developer-test-mode.test.js... ✅ PASS (0.41s)
[27/35] apps/payment-api/src/__tests__/device-binding-duplicate-session.test.js... ✅ PASS (0.48s)
[28/35] apps/payment-api/src/__tests__/fraud-ban-pipeline.test.js... ✅ PASS (0.41s)
[29/35] apps/payment-api/src/__tests__/sms-gmail-verification-levels.test.js... ✅ PASS (3.62s)
[30/35] apps/payment-api/src/__tests__/upi-server-health-and-pc-ui.test.js... ✅ PASS (0.38s)
[31/35] apps/payment-api/src/__tests__/whatsapp-berry-auth.test.js... ✅ PASS (3.48s)
[32/35] apps/payment-api/src/__tests__/whitelabel-branding.test.js... ✅ PASS (0.41s)
[33/35] apps/payment-api/src/__tests__/cod-parallel-timer-decoupling.test.js... ✅ PASS (0.36s)
[34/35] scripts/chaos-concurrency.test.js... ✅ PASS (0.31s)
[35/35] scripts/production-infrastructure.test.js... ✅ PASS (0.29s)
```

### 2. V-Visa Platform Suite
Command: `npm test`  
Location: `C:\vvisas-ai\V-VISAS\B2B-V-Visa-main`  
Result: **31/31 Suites Passed (243/243 Tests)** (Total runtime: 19.80s)
- All Zoho Payments & Wallet Ledger invariant suites pass cleanly.
- YouPI UPI Gateway feature flag safety verified: `ENABLE_YOUPI_UPI=false`.

---

## Non-Negotiable Boundaries Audit

1. **Production Feature Flag**: Confirmed `ENABLE_YOUPI_UPI=false` in V-Visa configuration.
2. **Zoho Payments Primacy**: Zoho Payments remains 100% active, primary, and untouched in production.
3. **Zero Deployment**: Zero modifications, migrations, or deployments were executed against the Oracle staging VM or production environments.
4. **Zero Live Accounts / Credentials**: No real bank accounts, real VPAs, live Gmail OAuth credentials, or physical Android devices were connected.
5. **Zero Funds Transferred**: All verification was completed exclusively via synthetic test fixtures and in-memory databases.

---

## Release-Candidate Status

With the successful execution and empirical validation of Checks 1 through 5 across 35 YouPI test suites and 243 V-Visa platform tests, the codebase meets all architectural and concurrency requirements to be designated a **Verified Release-Candidate**.
