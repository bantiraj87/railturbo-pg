# Mitto Pay — Gate 2 Remediation Baseline Report

**Repository:** `C:\vvisas-ai\YouPI-PG`  
**Branch:** `mitto-pay-main`  
**Current HEAD SHA:** `eb613a9fd1e598a2e4e579343860aad7fdca169a`  
**Upstream Tracking:** `origin/mitto-pay-main` (synchronized, 0 ahead / 0 behind)  
**Related V-Visa Repository:** `C:\vvisas-ai\V-VISAS\B2B-V-Visa-main` (HEAD: `3cb80f5fd973948723cbf6dbe965873657cab4c3`)  
**Target Oracle VM:** `130.210.28.51` (`youpi-vvisa-staging-x86`)  
**Date:** October 21, 2026

---

## 1. YouPI-PG Working Tree State

- **Branch:** `mitto-pay-main`
- **HEAD Commit:** `eb613a9fd1e598a2e4e579343860aad7fdca169a` ("feat(observer): controlled startup lifecycle, prerequisite preflight and authenticated rate-limited control endpoints")
- **Modified Tracked Files (8):**
  1. `apps/android-observer-app/__tests__/android-observer.test.js`
  2. `apps/android-observer-app/app/src/main/AndroidManifest.xml`
  3. `apps/android-observer-app/app/src/main/java/com/youpi/observer/ApiClient.java`
  4. `apps/android-observer-app/app/src/main/java/com/youpi/observer/MainActivity.java`
  5. `apps/android-observer-app/app/src/main/java/com/youpi/observer/SmsReceiver.java`
  6. `apps/android-observer-app/driver.js`
  7. `apps/payment-api/src/routes/payments.routes.js`
  8. `apps/payment-api/src/routes/pollers.routes.js`
- **Untracked Intended Files (3):**
  1. `apps/android-observer-app/app/src/main/java/com/youpi/observer/BankSmsFilter.java`
  2. `apps/android-observer-app/__tests__/mitto-pay-stage3-synthetic-integration.test.js`
  3. `apps/payment-api/src/__tests__/canary-isolation-verification.test.js`
- **Untracked Runtime Leak (1):**
  1. `data/gmail_processed_ids.json` (created by test runner; must be ignored via `.gitignore`)
- **Staging Area:** Clean (0 staged files).
- **Declared Engine:** `"engines": { "node": ">=24.0.0" }` in root `package.json`.

---

## 2. Oracle VM Environment Baseline (`130.210.28.51`)

- **OS / Kernel:** Ubuntu Linux 6.17.0-1020-oracle x86_64
- **Node.js Executable:** `/usr/bin/node` (`v22.23.3`)
- **npm Version:** `10.9.9`
- **Disk Availability:** `/dev/sda1` 45G total, 6.3G used, 38G available (15% utilization)
- **Active Systemd Units:**
  - `youpi-staging.service`: `active` (PID running `scripts/start.js` from `/opt/youpi-pg`)
  - `cloudflared-staging.service`: `active` (tunnels to `pay.vvisa.in` [7000] and `pay-api.vvisa.in` [6100])
- **Deployed Codebase on VM:** `/opt/youpi-pg`
  - `DEPLOYED_COMMIT`: `560037147b5dcdc3620ee4efa40c5fff2496a418+gate4-gmail-observer`
  - `package.json` engines on VM: `node: ">=20.0.0"`
- **Known-Good Backup on VM:** `/opt/youpi-pg-backup-pre-gate4`
  - `DEPLOYED_COMMIT`: `560037147b5dcdc3620ee4efa40c5fff2496a418+phase9d-hardened`
- **Environment Configuration:** `/etc/youpi/staging.env`
  - `YOUPI_VERIFICATION_POLICY=REQUIRE_DUAL_CHANNEL` (Verified present)
  - `CANARY_MERCHANT_ALLOWLIST` (Verified absent)

---

## 3. V-Visa Gateway Isolation Baseline

- **Repository:** `C:\vvisas-ai\V-VISAS\B2B-V-Visa-main`
- **HEAD Commit:** `3cb80f5fd973948723cbf6dbe965873657cab4c3`
- **Feature Flag:** `ENABLE_YOUPI_UPI: z.coerce.boolean().default(false)` in `src/lib/env.ts`
- **Default Gateway:** `provider: z.enum(['ZOHO', 'YOUPI']).default('ZOHO')` in `src/app/api/payments/orders/route.ts`
- **Pilot Agency Guard:** `isAgencyAuthorizedForYouPi(session.agency.vvisaUid)` restricts YouPI access to `YOUPI_PILOT_STAFF_AGENCY_UID`
- **Status:** Production traffic strictly isolated to Zoho Payments.
