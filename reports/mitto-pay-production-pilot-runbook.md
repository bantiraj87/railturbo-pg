# Mitto Pay Production Pilot Runbook & Operational Guide

**Document Version:** 1.0.0  
**Effective Date:** 2026-10-21  
**Target Environment:** Oracle VM `130.210.28.51` (`youpi-staging.service`)  
**Authorized Merchant / Agency:** `VVANFTTKRA` (`cmrnlpf9z0001ju04htfqb9my`, V-Visa)  
**Safety Status:** Restricted Pilot (Zoho Payments remains V-Visa primary; `ENABLE_YOUPI_UPI=false`)

---

## 1. Architecture & Security Safeguards

### A. Fail-Closed Merchant Allowlist
- **Canonical Configuration:**
  ```bash
  CANARY_MODE=true
  CANARY_MERCHANT_ALLOWLIST=VVANFTTKRA
  YOUPI_VERIFICATION_POLICY=REQUIRE_DUAL_CHANNEL
  ```
- **Boundary Enforcement:**
  1. `assertCanaryMerchantAllowed` in `@youpi/common`: verifies that incoming request metadata `agencyVvisaUid` strictly equals `VVANFTTKRA` and that server-resolved merchant branding includes `vvisaUid: "VVANFTTKRA"`.
  2. `PaymentSessionRepository.create`: database boundary check throws `CanaryMerchantUnauthorizedError` (HTTP 403) before inserting into `payment_sessions`.
  3. `checkout.routes.js` (`handleEndAndRestartPayment`): blocks restart/re-binding attempts for unauthorized sessions.

### B. Dual-Channel Verification Settlement Policy
- Single-channel bank SMS notifications transition sessions to `PROCESSING` (Level 1).
- Secondary corroboration via Gmail Observer or WhatsApp Berry Protocol is required to advance session status to `SUCCESS` (Level 2).
- Premature crediting is structurally prevented in `PaymentVerificationPipeline`.

### C. V-Visa Accounting & Ledger Invariants
- **Database Schema:** PostgreSQL (`PrismaClient`).
- **Models:**
  - `PaymentOrder`: Tracks order life cycle (`PENDING` → `PROVIDER_SESSION_CREATED` → `CONFIRMED`).
  - `PaymentTransaction`: Stores provider transaction reference and `webhookEventId`. Unique constraint enforces idempotency.
  - `WalletLedgerEntry`: Immutable append-only double-entry ledger. Idempotency key `wallet:order-deposit:<paymentOrderId>` prevents duplicate credits.
  - `Wallet`: Balance derived from sum of completed ledger entries.
  - `IntegrationEvent`: Zoho CRM / Books async outbox.

---

## 2. Pre-Flight Verification Checklist

Before initiating any real pilot transaction, verify:
1. `youpi-staging.service` is active:
   ```bash
   ssh -i C:\Users\vinod\.ssh\id_ed25519_oracle_staging ubuntu@130.210.28.51 "systemctl is-active youpi-staging.service"
   ```
2. Deployed Git commit matches approved Release Candidate:
   ```bash
   ssh -i C:\Users\vinod\.ssh\id_ed25519_oracle_staging ubuntu@130.210.28.51 "cat /opt/youpi-pg/DEPLOYED_COMMIT"
   # Must return: 9e4763c66c82c8ba246f00b6fa3347428be7be38
   ```
3. Cloudflare tunnel and API reachability:
   - `curl -s https://pay-api.vvisa.in/api/v1/health` → `{"status":"UP", ...}`
   - `curl -s -I https://pay.vvisa.in` → HTTP 200/404 dynamic
4. Gmail Observer active on VM:
   - `curl -s http://127.0.0.1:6003/health` → `{"status":"UP","service":"gmail-observer","lifecycleState":"ACTIVE", ...}`
5. V-Visa production configuration:
   - `ENABLE_YOUPI_UPI=false` (verified in `src/lib/env.ts`).

---

## 3. Rollback & Emergency Stop Procedure

If an anomaly occurs (duplicate ledger entry, unauthorized merchant access, or uncorroborated settlement):

### Step 1: Immediately Stop Gateway
```bash
ssh -i C:\Users\vinod\.ssh\id_ed25519_oracle_staging ubuntu@130.210.28.51 "sudo systemctl stop youpi-staging.service"
```

### Step 2: Restore Known-Good Snapshot
```bash
ssh -i C:\Users\vinod\.ssh\id_ed25519_oracle_staging ubuntu@130.210.28.51 "sudo rm -rf /opt/youpi-pg && sudo cp -r /opt/youpi-pg-backup-pre-mitto-canary /opt/youpi-pg && sudo systemctl start youpi-staging.service"
```

### Step 3: Quarantine Transaction
Record transaction order ID and notify accounting to inspect `WalletLedgerEntry`.
