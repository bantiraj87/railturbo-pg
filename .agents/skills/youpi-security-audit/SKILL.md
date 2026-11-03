---
name: youpi-security-audit
description: Verify payment state machine invariants, raw payload HMAC signatures, device binding fail-closed security, and session token enforcement. Use when modifying checkout endpoints, webhook delivery, auth guards, or running security regression test suites.
metadata:
  version: "1.0.0"
---

# YouPI Security & Invariants Audit Skill

Use this skill when auditing or modifying core payment APIs, checkout lifecycle, webhook signatures, or authorization guards in YOUPI PG V2.

## Mandatory Architectural & Security Invariants

### 1. Server-to-Server HMAC Signature Over Raw Bytes
- The HMAC-SHA256 signature (`X-Gateway-Signature`) **MUST be computed over the raw, unparsed request payload string**.
- Never parse JSON before computing HMAC.
- Header contracts:
  - `X-Gateway-Signature: sha256=<hex>`
  - `X-Gateway-Timestamp: <ms>`
  - `X-Gateway-Event: SUCCESS`
  - `X-Gateway-Delivery-Id: <uuid>`
- Signature verification helper: `YoupiPaymentClient.verifyWebhook(rawPayloadString, signatureHeader, customSecret)` verifies `HMAC-SHA256(secret, rawBody)` in constant time. It takes no timestamp argument; replay protection is implemented by the RECEIVER, for example `apps/coin-wallet-store/src/server.js` (X-Gateway-Timestamp skew window plus X-Gateway-Delivery-Id deduplication).

### 2. Device Binding & Fail-Closed Access Control
- `checkSessionDeviceAccess(session, req, body, ctx)` in `apps/payment-api/src/routes/checkout.routes.js`:
  - When a payment session is bound to an active device (`session.deviceId`), a request from a DIFFERENT device is rejected with `HTTP 409 DUPLICATE_SESSION_DETECTED`. Omitting `X-Device-Id` on a bound session is also rejected, with the same 409; there is no `401 DEVICE_ID_REQUIRED` response.
  - Mismatched device identities must return `HTTP 409 DUPLICATE_SESSION_DETECTED`.
  - Only a co-located internal renderer bypasses the device lock, and it must present the internal service token over loopback (`isInternalServiceRequest()` in `packages/common/src/secrets.js`). Admin tokens and `X-Merchant-Key` do NOT bypass it - do not add such a bypass.

### 3. Payment Creation Guard (`POST /api/v1/payments`)
- `X-Merchant-Key` (the merchant's webhook secret) is OPTIONAL on `POST /api/v1/payments`; when present it is validated, and when absent the request proceeds. There is no `apiKeyHash` column. The key grants the merchant-private view of a session on `GET /api/v1/payments/:id` and the COD endpoints, where an anonymous caller receives a redacted view.
- `autoActivate: true` is currently honoured unconditionally on `POST /api/v1/payments` - there is no `403 AUTOACTIVATE_FORBIDDEN` guard. If you rely on auto-activation being blocked in production, add that guard; do not assume it exists.

### 4. Running Verification Test Suites
Verify all invariants locally before committing:
```bash
npm run typecheck
npm test
```
All 38 test suites must pass 100% cleanly.
