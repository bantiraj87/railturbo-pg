package com.youpi.observer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;
import java.util.UUID;

public class SmsReceiver extends BroadcastReceiver {
    private static final String TAG = "MittoPaySmsReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        final ApiClient client = new ApiClient(context);
        if (!client.isPaired()) {
            Log.w(TAG, "SMS received but device is not paired with Mitto Pay Gateway. Skipping.");
            return;
        }

        for (SmsMessage sms : messages) {
            if (sms == null) continue;
            final String sender = sms.getOriginatingAddress();
            final String body = sms.getMessageBody();
            final long timestamp = sms.getTimestampMillis();

            // Strict On-Device Data Minimization & Privacy Protection:
            // Evaluate on-device first. Discard personal, non-financial, or debit messages immediately.
            BankSmsFilter.FilterDecision decision = BankSmsFilter.evaluate(sender, body);
            if (!decision.isAllowed) {
                Log.d(TAG, "Locally discarded non-banking / personal SMS from: [" + sender + "] Reason: " + decision.reason);
                continue;
            }

            final String clientMessageId = UUID.randomUUID().toString();
            Log.i(TAG, "Valid bank credit alert accepted from [" + sender + "]. Dispatching ID: " + clientMessageId);

            // Dispatch validated financial alert to Mitto Pay Gateway in asynchronous worker thread
            new Thread(new Runnable() {
                @Override
                public void run() {
                    boolean success = client.sendSms(sender, body, timestamp, clientMessageId);
                    Log.i(TAG, "Dispatched bank SMS to Mitto Pay Gateway (" + clientMessageId + "): " + (success ? "SUCCESS" : "FAILED"));
                }
            }).start();
        }
    }
}
