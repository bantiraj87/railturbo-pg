---
name: youpi-android-gateway
description: Build, package, and verify the YouPI SMS Gateway Android background observer app. Use when updating Java notification listener services, modifying package allowlists, or building the certified APK.
metadata:
  version: "1.0.0"
---

# YouPI Android Gateway Skill

Use this skill when developing, testing, or building the Android Banking SMS/Notification Observer app (`apps/android-observer-app`).

## Architecture & Lifecycle

- **Package**: `com.youpi.observer`
- **Target OS**: Android 8.0 (API 26) through Android 14+ (API 34).
- **Core Components**:
  1. `PaymentNotificationListenerService`: Extends `NotificationListenerService` to intercept banking SMS and UPI app push notifications.
  2. `ForegroundService`: Persistent low-priority background daemon keeping observer connection alive across aggressive OEM battery managers (MIUI, ColorOS, OneUI).
  3. `ApiClient`: Posts captured bank alerts to the gateway endpoints `/api/v1/observers/sms` (SMS broadcast) or `/api/v1/pollers/android/events` (notification listener), with HMAC authentication and the device token.

## Banking Package Allowlist

To prevent intercepting personal messages, notifications are strictly filtered against an approved banking package allowlist.

### Synchronizing Allowlist:
Run the idempotent allowlist synchronization script whenever packages or banking providers change:
```bash
node scripts/sync-android-allowlist.js
```
This updates the `ALLOWED_BANKING_PACKAGES` set in `apps/android-observer-app/app/src/main/java/com/youpi/observer/PaymentNotificationListenerService.java`.

## Certified APK Build Process

To compile a certified release APK with SHA-256 checksum:
```bash
npm run build:android:apk
```

The build script (`scripts/build-android-apk.js`):
1. Resolves Android SDK, `build-tools`, and `platforms/android-34`.
2. Compiles resources via `aapt2`.
3. Compiles Java source files with `javac` (Target Java 17).
4. Converts bytecode with `d8`.
5. Packages and signs APK with `apksigner`.
6. Generates `youpi-sms-gateway.apk.sha256` and mirrors the binary to public download routes:
   - `apps/android-observer-app/youpi-sms-gateway.apk`
   - `apps/payment-api/public/youpi-sms-gateway.apk`
   - `apps/merchant-admin/public/youpi-sms-gateway.apk`

## Running Android Observer Regression Tests

Verify headless observer behavior and driver simulations:
```bash
node --test apps/android-observer-app/__tests__/android-observer.test.js
```
