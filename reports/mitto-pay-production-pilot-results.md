# Mitto Pay Production Pilot Execution Results

**Execution Timestamp:** 2026-10-21T09:28:00Z  
**Target Host:** Oracle Cloud VM `130.210.28.51`  
**Deployed Release Candidate:** Commit `9e4763c66c82c8ba246f00b6fa3347428be7be38`  
**Release Artifact:** `reports/mitto-pay-rc1.tar.gz` (SHA-256: `c6b9fdd76dfa8962ca4ae2cd7082ff951d41a7de4836209ed7559fbcbecc39f2`)  
**Authorized Merchant:** `VVANFTTKRA` (`cmrnlpf9z0001ju04htfqb9my`, V-Visa)  
**Canary Mode:** `FAIL_CLOSED`  
**Dual-Channel Policy:** `REQUIRE_DUAL_CHANNEL`

---

## 1. Automated Staging Verification Summary

| Test Case | Method & Endpoint | Payload / Metadata | Expected Result | Actual Result | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Unauthorized Merchant Denial** | `POST http://127.0.0.1:6100/api/v1/payments` | `agencyVvisaUid: "UNAUTHORIZED_AGENCY"` | HTTP 403 `CANARY_MERCHANT_UNAUTHORIZED` | HTTP 403 `CANARY_MERCHANT_UNAUTHORIZED` | **PASS** |
| **Missing Metadata Denial** | `POST http://127.0.0.1:6100/api/v1/payments` | No metadata supplied | HTTP 403 `CANARY_MERCHANT_UNAUTHORIZED` | HTTP 403 `CANARY_MERCHANT_UNAUTHORIZED` | **PASS** |
| **Authorized Canary Merchant** | `POST http://127.0.0.1:6100/api/v1/payments` | `agencyVvisaUid: "VVANFTTKRA"` | HTTP 201 `INITIATED` | HTTP 201 `paymentId: 8d5adfdd-56f7-4646-875f-7b104ac62620` | **PASS** |
| **Public Checkout Portal** | `GET https://pay.vvisa.in/checkout/8d5adfdd...` | N/A | HTTP 200 HTML with UPI Options | HTTP 200 OK HTML | **PASS** |
| **Core API Health** | `GET https://pay-api.vvisa.in/api/v1/health` | N/A | HTTP 200 `{"status":"UP", ...}` | HTTP 200 `{"status":"UP","service":"payment-api"}` | **PASS** |
| **Gmail Observer Lifecycle** | `GET http://127.0.0.1:6003/health` | Loopback Port 6003 | HTTP 200 `ACTIVE` | HTTP 200 `ACTIVE` (`connectedEmail: v***@gmail.com`) | **PASS** |
| **WhatsApp Berry Protocol** | Port 6001 Admin Hub | Sub-view 3.6 | Web QR generator ready | Active and ready for device pairing | **PASS** |

---

## 2. V-Visa Production Isolation Audit

- **Environment Flag:** `ENABLE_YOUPI_UPI=false` (Verified in `src/lib/env.ts` line 233).
- **Default Payment Gateway:** `ZOHO` (Orders route `src/app/api/payments/orders/route.ts` defaults to Zoho Payments).
- **Pilot Staff Guard:** `isAgencyAuthorizedForYouPi` checks `YOUPI_PILOT_STAFF_AGENCY_UID=VVISA-INTERNAL-OPS`.
- **Integrations Status:** Live customer traffic on V-Visa cannot access YouPI UPI without explicit code and env alteration.
