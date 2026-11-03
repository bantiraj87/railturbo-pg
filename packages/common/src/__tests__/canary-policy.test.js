import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCanaryMerchantEligibility,
  parseCanaryAllowlist,
  assertCanaryVerificationPolicy,
  assertCanaryMerchantAllowed,
  CanaryConfigurationError,
  CanaryMerchantUnauthorizedError
} from '../canary-policy.js';

describe('Centralized Canary Merchant Isolation Policy Tests', () => {
  const AUTHORIZED_MERCHANT = {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'vvisa-ops',
    branding: { vvisaUid: 'VVANFTTKRA' }
  };

  const UNAUTHORIZED_MERCHANT = {
    id: '00000000-0000-0000-0000-000000000999',
    slug: 'unauthorized-merchant',
    branding: { vvisaUid: 'SOME_UNAUTH_UID' }
  };

  // 1. Canary mode inactive preserves normal behavior
  test('1. When canary mode is inactive, all merchants are permitted', () => {
    const res = evaluateCanaryMerchantEligibility(UNAUTHORIZED_MERCHANT, {
      env: {}
    });
    assert.equal(res.allowed, true);
    assert.equal(res.canaryActive, false);
  });

  // 2. Missing allowlist when CANARY_MODE=true fails closed
  test('2. Fails closed with 500 when CANARY_MODE=true but allowlist is missing', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      env: { CANARY_MODE: 'true' }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 500);
    assert.equal(res.code, 'INVALID_CANARY_CONFIGURATION');
  });

  // 3. Empty allowlist fails closed
  test('3. Fails closed with 500 when CANARY_MERCHANT_ALLOWLIST is empty string', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      env: { CANARY_MERCHANT_ALLOWLIST: '', YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL' }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 500);
  });

  // 4. Whitespace-only allowlist fails closed
  test('4. Fails closed with 500 when CANARY_MERCHANT_ALLOWLIST is whitespace only', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      env: { CANARY_MERCHANT_ALLOWLIST: '   \t  ', YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL' }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 500);
  });

  // 5. Empty token in comma-separated allowlist fails closed
  test('5. Fails closed when allowlist contains empty entries (e.g., "M1,,M2")', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      env: { CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA,,OTHER_MERCHANT', YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL' }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 500);
    assert.match(res.error, /empty identifier token/);
  });

  // 6. Malformed identifier with invalid characters fails closed
  test('6. Fails closed when allowlist contains invalid characters', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      env: { CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA,bad@merchant!', YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL' }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 500);
    assert.match(res.error, /malformed identifier/);
  });

  // 7. Policy requirement: fails closed if verification policy is not REQUIRE_DUAL_CHANNEL
  test('7. Fails closed if verification policy is not valid canary policy', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      env: {
        CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA',
        YOUPI_VERIFICATION_POLICY: 'INVALID_POLICY'
      }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 500);
    assert.equal(res.code, 'INVALID_VERIFICATION_POLICY');
  });

  test('7b. Passes when verification policy is SINGLE_CHANNEL_VALIDATED_GMAIL', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      requestedAgencyVvisaUid: 'VVANFTTKRA',
      env: {
        CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA',
        YOUPI_VERIFICATION_POLICY: 'SINGLE_CHANNEL_VALIDATED_GMAIL'
      }
    });
    assert.equal(res.allowed, true);
  });

  // 8. Authorized merchant succeeds when properly configured
  test('8. Authorized merchant is granted access when allowlist and dual-channel policy match', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      requestedAgencyVvisaUid: 'VVANFTTKRA',
      env: {
        CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA',
        YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL'
      }
    });
    assert.equal(res.allowed, true);
    assert.equal(res.canaryActive, true);
    assert.equal(res.matchedIdentifier, 'vvanfttkra');
  });

  // 9. Unauthorized merchant is rejected with 403
  test('9. Unauthorized merchant is rejected with 403 CANARY_MERCHANT_UNAUTHORIZED', () => {
    const res = evaluateCanaryMerchantEligibility(UNAUTHORIZED_MERCHANT, {
      env: {
        CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA',
        YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL'
      }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.code, 'CANARY_MERCHANT_UNAUTHORIZED');
  });

  // 10. Forged client body cannot override unauthorized server-resolved merchant
  test('10. Client cannot forge access by supplying authorized UID in body against unauthorized merchant', () => {
    const res = evaluateCanaryMerchantEligibility(UNAUTHORIZED_MERCHANT, {
      requestedAgencyVvisaUid: 'VVANFTTKRA', // Forged in request body
      env: {
        CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA',
        YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL'
      }
    });
    // Server-resolved merchant is NOT authorized, so request is blocked
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 403);
  });

  // 11. Client sending unauthorized agency UID in body against authorized merchant is rejected
  test('11. Client sending untrusted non-canary agency UID in body is rejected', () => {
    const res = evaluateCanaryMerchantEligibility(AUTHORIZED_MERCHANT, {
      requestedAgencyVvisaUid: 'ATTACKER_AGENCY_999',
      env: {
        CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA',
        YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL'
      }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.statusCode, 403);
  });

  // 12. assertCanaryMerchantAllowed throws typed errors
  test('12. assertCanaryMerchantAllowed throws typed error instances', () => {
    assert.throws(
      () => {
        assertCanaryMerchantAllowed(UNAUTHORIZED_MERCHANT, {
          env: { CANARY_MERCHANT_ALLOWLIST: 'VVANFTTKRA', YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL' }
        });
      },
      (err) => err instanceof CanaryMerchantUnauthorizedError && err.code === 'CANARY_MERCHANT_UNAUTHORIZED'
    );

    assert.throws(
      () => {
        assertCanaryMerchantAllowed(AUTHORIZED_MERCHANT, {
          env: { CANARY_MERCHANT_ALLOWLIST: '', YOUPI_VERIFICATION_POLICY: 'REQUIRE_DUAL_CHANNEL' }
        });
      },
      (err) => err instanceof CanaryConfigurationError && err.code === 'INVALID_CANARY_CONFIGURATION'
    );
  });
});
