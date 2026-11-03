# Mitto Pay Financial Reconciliation Audit & Accounting Model

**Date:** 2026-10-21  
**Target Merchant:** V-Visa (`VVANFTTKRA` / `cmrnlpf9z0001ju04htfqb9my`)  
**Currency:** INR (Amounts tracked in paise / minor units)  
**Database:** PostgreSQL (`public.wallets`, `public.wallet_ledger_entries`, `public.payment_orders`, `public.payment_transactions`)

---

## 1. Accounting Lifecycle Trace

The full financial lifecycle for Mitto Pay payments adheres to this strict sequence:

```
[Payment Creation] -> [PaymentOrder: PENDING]
        |
[Customer Checkout] -> [YouPI Session: INITIATED -> ACTIVE]
        |
[Bank Confirmation] -> [Channel 1: SMS Observer -> PROCESSING (Level 1)]
        |
[Dual Confirmation] -> [Channel 2: Gmail API / WhatsApp -> SUCCESS (Level 2)]
        |
[Authenticated Webhook] -> [POST /api/payments/youpi/webhook (HMAC-SHA256 verified)]
        |
[Atomic DB Transaction]:
   1. PaymentTransaction created (status: CONFIRMED, webhookEventId deduplicated)
   2. PaymentOrder updated (status: CONFIRMED)
   3. WalletLedgerEntry created (type: DEPOSIT_CONFIRMED, amount: +minor, idempotencyKey: wallet:order-deposit:<id>)
   4. Wallet balance increments atomically
        |
[Zoho CRM / Books Outbox Worker]:
   1. TRANSACTION_CREATE queued to IntegrationEvent
   2. ZOHO_BOOKS_PAYMENT_SYNC queued to IntegrationEvent
   3. Outbox worker invokes syncPaidApplicationToZohoBooks()
```

---

## 2. Invariant Reconciliation Table

| Check | Requirement | Verified Mechanism | Status |
| :--- | :--- | :--- | :--- |
| **Merchant Ownership** | Only merchant's designated agency wallet can receive deposit | Verified via `paymentOrder.agencyId === wallet.agencyId` | **PASS** |
| **Double-Credit Prevention** | Webhook or polling retries must never credit wallet twice | Verified via unique `idempotencyKey` on `wallet_ledger_entries` (`wallet:order-deposit:<id>`) | **PASS** |
| **UTR / Provider Transaction Deduplication** | Same UTR from bank SMS cannot be applied to another order | Enforced by `payment_transactions.providerPaymentId` cross-check | **PASS** |
| **Amount & Currency Precision** | Minor units (paise) match exactly | Checked in `payload.amountPaise === paymentOrder.amountMinor`; currency uppercase equality | **PASS** |
| **Ledger Integrity** | Wallet balance matches mathematical sum of ledger entries | Validated: `totalBalanceMinor === sum(entries.amountMinor)` | **PASS** |
| **Zoho Books Synchronization** | Document creation in Zoho Books accounting | Scope blocker detected: Books requires `ZohoBooks.fullaccess.all` OAuth scope on Zoho refresh token | **FLAGGED / MANUAL REVIEW** |

---

## 3. Active Account Status (`VVANFTTKRA`)

- **Agency Record:** `cmrnlpf9z0001ju04htfqb9my` (`V-Visa`)
- **Wallet ID:** `cmrnlpfur0005ju04qq6i0md8`
- **Current Balance:** `142,100` paise (**₹1,421.00**)
- **Ledger Invariant:** Sum of 5 completed ledger entries matches exactly ₹1,421.00.
