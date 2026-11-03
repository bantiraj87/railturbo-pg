package com.youpi.observer;

import android.util.Log;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * On-Device Bank SMS Filter & Validator.
 *
 * Implements strict Google Play data-minimization and user privacy requirements:
 * 1. Validates that the SMS originated from an institutional TRAI banking shortcode.
 * 2. Immediately drops and discards personal phone number SMS on-device.
 * 3. Enforces that the SMS text represents a genuine inbound credit/deposit.
 * 4. Discards non-financial, OTP, promotional, or debit SMS before any network call.
 */
public class BankSmsFilter {
    private static final String TAG = "BankSmsFilter";

    // Standard TRAI Indian Institutional Sender pattern (e.g. VK-HDFCBK, AX-SBIINB, BZ-ICICIB, VM-AXISBK, or HDFCBK)
    private static final Pattern INSTITUTIONAL_SENDER_PATTERN = Pattern.compile(
        "^(?:[A-Za-z]{2}-)?([A-Za-z0-9]{3,9})$"
    );

    // Pure numeric sender pattern (mobile phone numbers, international prefixes)
    private static final Pattern NUMERIC_PHONE_PATTERN = Pattern.compile(
        "^\\+?[0-9]{7,15}$"
    );

    // Inbound Credit / Deposit keywords
    private static final Pattern CREDIT_KEYWORD_PATTERN = Pattern.compile(
        "(?:credited|received|deposit(?:ed)?|payment\\s+received|transferred\\s+to\\s+your|has\\s+transferred|deposited\\s+in|cr\\b|upi\\s+credit)",
        Pattern.CASE_INSENSITIVE
    );

    // Explicit Debit keywords (must not be present as primary intent without credit)
    private static final Pattern EXPLICIT_DEBIT_PATTERN = Pattern.compile(
        "(?:debited\\b|spent\\s+on|paid\\s+to|withdrawn\\s+from|dr\\b|payment\\s+sent)",
        Pattern.CASE_INSENSITIVE
    );

    // Monetary Amount pattern (e.g., Rs. 500.00, INR 1,250, ₹ 200.50)
    private static final Pattern AMOUNT_PATTERN = Pattern.compile(
        "(?:Rs\\.?|INR|₹)\\s*([0-9,]+(?:\\.[0-9]{1,2})?)",
        Pattern.CASE_INSENSITIVE
    );

    // 12-digit UPI Transaction Reference (UTR)
    private static final Pattern UTR_PATTERN = Pattern.compile(
        "(?:UPI\\s*(?:ref|reference|txn|id)?|Ref(?:erence)?\\s*(?:no|number)?|UTR|IMPS\\s*Ref)\\s*[:#-]?\\s*([0-9]{12})",
        Pattern.CASE_INSENSITIVE
    );

    public static class FilterDecision {
        public final boolean isAllowed;
        public final String reason;
        public final double amount;
        public final long amountPaise;
        public final String bankRef;

        public FilterDecision(boolean isAllowed, String reason, double amount, long amountPaise, String bankRef) {
            this.isAllowed = isAllowed;
            this.reason = reason;
            this.amount = amount;
            this.amountPaise = amountPaise;
            this.bankRef = bankRef;
        }

        public static FilterDecision reject(String reason) {
            return new FilterDecision(false, reason, 0.0, 0L, null);
        }

        public static FilterDecision accept(double amount, long amountPaise, String bankRef) {
            return new FilterDecision(true, "ACCEPTED_BANK_CREDIT_ALERT", amount, amountPaise, bankRef);
        }
    }

    /**
     * Evaluates an incoming SMS on-device before any network dispatch.
     * @param sender Originating address / phone number
     * @param body Text message content
     * @return FilterDecision with acceptance status and parsed details
     */
    public static FilterDecision evaluate(String sender, String body) {
        if (sender == null || sender.trim().isEmpty()) {
            return FilterDecision.reject("EMPTY_SENDER");
        }
        if (body == null || body.trim().isEmpty()) {
            return FilterDecision.reject("EMPTY_BODY");
        }

        String cleanSender = sender.trim().replaceAll("\\s+", "");

        // 1. Immediately drop personal phone numbers
        if (NUMERIC_PHONE_PATTERN.matcher(cleanSender).matches()) {
            Log.d(TAG, "Dropped personal SMS from numeric sender: " + cleanSender);
            return FilterDecision.reject("PERSONAL_PHONE_NUMBER_REJECTED");
        }

        // 2. Validate institutional sender format
        Matcher senderMatcher = INSTITUTIONAL_SENDER_PATTERN.matcher(cleanSender);
        if (!senderMatcher.matches()) {
            Log.d(TAG, "Dropped non-institutional sender: " + cleanSender);
            return FilterDecision.reject("NON_INSTITUTIONAL_SENDER");
        }

        // 3. Must contain inbound credit intent
        if (!CREDIT_KEYWORD_PATTERN.matcher(body).find()) {
            Log.d(TAG, "Dropped SMS without credit keywords from: " + cleanSender);
            return FilterDecision.reject("NO_CREDIT_KEYWORD");
        }

        // 4. If explicit debit keywords are present without clear inbound context, drop
        if (EXPLICIT_DEBIT_PATTERN.matcher(body).find() && !body.toLowerCase().contains("reversed")) {
            Log.d(TAG, "Dropped debit/withdrawal alert from: " + cleanSender);
            return FilterDecision.reject("DEBIT_ALERT_REJECTED");
        }

        // 5. Extract monetary amount
        Matcher amountMatcher = AMOUNT_PATTERN.matcher(body);
        if (!amountMatcher.find()) {
            Log.d(TAG, "Dropped SMS without identifiable amount from: " + cleanSender);
            return FilterDecision.reject("NO_AMOUNT_FOUND");
        }

        double amount = 0.0;
        try {
            String rawAmountStr = amountMatcher.group(1).replace(",", "");
            amount = Double.parseDouble(rawAmountStr);
        } catch (Exception e) {
            return FilterDecision.reject("INVALID_AMOUNT_FORMAT");
        }

        if (amount <= 0.0) {
            return FilterDecision.reject("ZERO_AMOUNT");
        }

        long amountPaise = Math.round(amount * 100);

        // 6. Extract optional 12-digit UTR reference
        String bankRef = null;
        Matcher utrMatcher = UTR_PATTERN.matcher(body);
        if (utrMatcher.find()) {
            bankRef = utrMatcher.group(1);
        }

        Log.i(TAG, "Accepted banking alert from [" + cleanSender + "]: ₹" + amount + (bankRef != null ? (" UTR: " + bankRef) : ""));
        return FilterDecision.accept(amount, amountPaise, bankRef);
    }
}
