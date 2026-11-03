---
name: youpi-banking-observer
description: Audit, simulate, and extend bank SMS and Gmail payment observation parsers. Use when adding bank notification regex patterns, testing UTR extraction, or simulating webhook payloads for SBI, HDFC, ICICI, Axis, Kotak, and UPI apps.
metadata:
  version: "1.0.0"
---

# YouPI Banking Observer Skill

Use this skill when developing, testing, or auditing payment observation parsers (SMS and Gmail push notifications) in YOUPI PG V2.

## Core Banking Principles

1. **Zero Force-Success**: Payment `SUCCESS` is never arbitrarily asserted by clients or public endpoints. It is derived strictly by matching genuine bank credit notifications containing authentic UTRs, matching amounts, and valid timestamps.
2. **Realistic Regex & Telemetry**: Never guess or hardcode fake bank SMS formats. Always cross-reference real-world Indian banking notification telemetry (SBI, HDFC, ICICI, Axis, PNB, Kotak, etc.) and NPCI UPI specifications.
3. **Double Verification**: Both SMS and Gmail observers parse independent credit channels into a normalized payment event:
   - `amount`: Clean decimal amount in INR.
   - `utr`: 12-digit standard bank reference number (RRN/UTR).
   - `account`: Last 3-4 digits of credited bank account or VPA.
   - `timestamp`: Notification arrival time.

## Simulating Observer Ingestion

### SMS Observer (`apps/sms-observer` on port `6002`):
Send a simulated incoming SMS payload:
```bash
curl -X POST http://localhost:6002/process-sms \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OBSERVER_API_TOKEN" \
  -d '{
    "sender": "VK-HDFCBK",
    "body": "Dear Customer, INR 499.00 credited to account **1234 on 21-OCT-26 by UPI/123456789012/Ref-TSHIRT. Available balance INR 10,450.00.",
    "timestamp": 1729536000000
  }'
```

### Gmail Observer (`apps/gmail-observer` on port `6003`):
Send a simulated incoming Gmail alert:
```bash
curl -X POST http://localhost:6003/process-email \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OBSERVER_API_TOKEN" \
  -d '{
    "subject": "Credit Alert: A/C *1234 credited with INR 499.00",
    "snippet": "INR 499.00 received via UPI ref 123456789012",
    "sender": "alerts@hdfcbank.net"
  }'
```

## Adding New Bank Regex Patterns

1. Update the parser in `packages/core/src/bank-sms-parser.js` (shared) or `apps/sms-observer/src/sms-parser.js`.
2. Ensure regex extracts:
   - `amountPaise` (integer in paise, e.g. 49900)
   - `utr` (`\b\d{12}\b` or bank specific alpha-numeric UTR)
3. Add dedicated regression unit test in `apps/payment-api/src/__tests__/sms-gmail-verification-levels.test.js`.
4. Run `npm test` to verify 100% test pass.
