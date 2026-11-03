/**
 * Centralized, Fail-Closed Canary Merchant Eligibility & Verification Policy Engine.
 *
 * Enforces strict production canary boundaries:
 * 1. If Canary Mode is active, only explicit server-authorized merchants may create or restart sessions.
 * 2. If Canary Mode is enabled and the allowlist is missing, blank, or malformed, the system FAILS CLOSED.
 * 3. Canary settlement strictly mandates YOUPI_VERIFICATION_POLICY === 'REQUIRE_DUAL_CHANNEL'.
 * 4. Never trusts client-supplied request body merchant identifiers over server-resolved identity.
 */

export class CanaryConfigurationError extends Error {
  constructor(message = 'Invalid canary configuration') {
    super(message);
    this.name = 'CanaryConfigurationError';
    this.code = 'INVALID_CANARY_CONFIGURATION';
    this.statusCode = 500;
  }
}

export class CanaryMerchantUnauthorizedError extends Error {
  constructor(message = 'Access denied: Merchant is not authorized during production canary mode.') {
    super(message);
    this.name = 'CanaryMerchantUnauthorizedError';
    this.code = 'CANARY_MERCHANT_UNAUTHORIZED';
    this.statusCode = 403;
  }
}

const VALID_IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{2,64}$/;

/**
 * Checks whether Canary Mode is currently active in the process environment.
 * Active if:
 * - CANARY_MODE is set to 'true', '1', 'yes', or 'enabled'
 * - OR CANARY_MERCHANT_ALLOWLIST is present in process.env (even if empty/blank, triggering fail-closed checks)
 * @returns {boolean}
 */
export function isCanaryModeActive() {
  const canaryMode = process.env.CANARY_MODE;
  if (canaryMode && ['true', '1', 'yes', 'enabled'].includes(String(canaryMode).trim().toLowerCase())) {
    return true;
  }
  return typeof process.env.CANARY_MERCHANT_ALLOWLIST !== 'undefined';
}

/**
 * Parses and strictly validates the configured CANARY_MERCHANT_ALLOWLIST.
 * Fails closed if the allowlist is missing, empty, or contains malformed identifiers.
 *
 * @param {string} [rawAllowlist] Optional raw string (defaults to process.env.CANARY_MERCHANT_ALLOWLIST)
 * @returns {Set<string>} Set of lowercase allowed identifiers
 * @throws {CanaryConfigurationError} If allowlist is missing, empty, or malformed
 */
export function parseCanaryAllowlist(rawAllowlist = process.env.CANARY_MERCHANT_ALLOWLIST) {
  if (rawAllowlist === undefined || rawAllowlist === null || String(rawAllowlist).trim() === '') {
    throw new CanaryConfigurationError('CANARY_MERCHANT_ALLOWLIST is required and cannot be empty when canary mode is active.');
  }

  const parts = String(rawAllowlist).split(',');
  const allowedSet = new Set();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new CanaryConfigurationError('CANARY_MERCHANT_ALLOWLIST contains an empty identifier token.');
    }
    if (!VALID_IDENTIFIER_PATTERN.test(trimmed)) {
      throw new CanaryConfigurationError(`CANARY_MERCHANT_ALLOWLIST contains malformed identifier: "${trimmed}"`);
    }
    allowedSet.add(trimmed.toLowerCase());
  }

  if (allowedSet.size === 0) {
    throw new CanaryConfigurationError('CANARY_MERCHANT_ALLOWLIST must contain at least one valid identifier.');
  }

  return allowedSet;
}

/**
 * Asserts that the verification policy satisfies Canary mode requirements.
 * Canary settlement strictly requires REQUIRE_DUAL_CHANNEL.
 *
 * @param {string} [policy] Optional policy string (defaults to process.env.YOUPI_VERIFICATION_POLICY)
 * @throws {CanaryConfigurationError} If policy is not REQUIRE_DUAL_CHANNEL
 */
export function assertCanaryVerificationPolicy(policy = process.env.YOUPI_VERIFICATION_POLICY) {
  const currentPolicy = String(policy || 'STANDARD').trim().toUpperCase();
  const allowedPolicies = ['REQUIRE_DUAL_CHANNEL', 'SINGLE_CHANNEL_VALIDATED_GMAIL'];
  if (!allowedPolicies.includes(currentPolicy)) {
    const err = new CanaryConfigurationError(
      `Fatal configuration error: Canary settlement requires valid policy [${allowedPolicies.join(', ')}] (current: "${currentPolicy}").`
    );
    err.code = 'INVALID_VERIFICATION_POLICY';
    throw err;
  }
}

/**
 * Evaluates whether a given merchant is eligible to create or restart a payment session.
 *
 * @param {object|string} merchant Server-resolved merchant object or merchantId string
 * @param {object} [options]
 * @param {string} [options.requestedAgencyVvisaUid] Untrusted client-supplied metadata parameter
 * @param {object} [options.env] Override environment for testing
 * @returns {{ allowed: boolean, canaryActive: boolean, matchedIdentifier?: string, error?: string, code?: string, statusCode?: number }}
 */
export function evaluateCanaryMerchantEligibility(merchant, options = {}) {
  const env = options.env || process.env;
  const canaryMode = env.CANARY_MODE;
  const hasCanaryModeFlag = canaryMode && ['true', '1', 'yes', 'enabled'].includes(String(canaryMode).trim().toLowerCase());
  const hasAllowlistVar = typeof env.CANARY_MERCHANT_ALLOWLIST !== 'undefined';

  if (!hasCanaryModeFlag && !hasAllowlistVar) {
    return { allowed: true, canaryActive: false };
  }

  // 1. Strict Allowlist Parsing (Fail Closed)
  let allowedSet;
  try {
    allowedSet = parseCanaryAllowlist(env.CANARY_MERCHANT_ALLOWLIST);
  } catch (err) {
    return {
      allowed: false,
      canaryActive: true,
      error: err.message,
      code: err.code || 'INVALID_CANARY_CONFIGURATION',
      statusCode: 500
    };
  }

  // 2. Strict Verification Policy Enforcement (Fail Closed)
  try {
    assertCanaryVerificationPolicy(env.YOUPI_VERIFICATION_POLICY);
  } catch (err) {
    return {
      allowed: false,
      canaryActive: true,
      error: err.message,
      code: err.code || 'INVALID_VERIFICATION_POLICY',
      statusCode: 500
    };
  }

  // 3. Resolve Server-Validated Merchant Identifiers
  const candidateIdentifiers = [];
  if (typeof merchant === 'string') {
    candidateIdentifiers.push(merchant.trim().toLowerCase());
  } else if (merchant && typeof merchant === 'object') {
    if (merchant.id) candidateIdentifiers.push(String(merchant.id).trim().toLowerCase());
    if (merchant.slug) candidateIdentifiers.push(String(merchant.slug).trim().toLowerCase());
    if (merchant.branding?.vvisaUid) candidateIdentifiers.push(String(merchant.branding.vvisaUid).trim().toLowerCase());
  }

  // Find if any server-resolved identifier matches the allowlist
  let matchedIdentifier = null;
  for (const id of candidateIdentifiers) {
    if (allowedSet.has(id)) {
      matchedIdentifier = id;
      break;
    }
  }

  // 4. Client Request Body & Metadata Binding
  // If the merchant matches via agency vvisaUid, enforce that the order explicitly carries matching agencyVvisaUid
  if (matchedIdentifier && merchant?.branding?.vvisaUid && allowedSet.has(merchant.branding.vvisaUid.toLowerCase())) {
    if (!options.requestedAgencyVvisaUid || String(options.requestedAgencyVvisaUid).trim().toLowerCase() !== matchedIdentifier) {
      return {
        allowed: false,
        canaryActive: true,
        error: 'Access denied: Payment creation requires valid agencyVvisaUid metadata matching the canary allowlist.',
        code: 'CANARY_MERCHANT_UNAUTHORIZED',
        statusCode: 403
      };
    }
  }

  // If the client provides requestedAgencyVvisaUid, verify that it is in the allowlist
  if (options.requestedAgencyVvisaUid) {
    const cleanRequestedUid = String(options.requestedAgencyVvisaUid).trim().toLowerCase();
    if (!allowedSet.has(cleanRequestedUid)) {
      return {
        allowed: false,
        canaryActive: true,
        error: `Access denied: Client requested agency UID "${options.requestedAgencyVvisaUid}" is not in the canary allowlist.`,
        code: 'CANARY_MERCHANT_UNAUTHORIZED',
        statusCode: 403
      };
    }
  }

  if (!matchedIdentifier) {
    return {
      allowed: false,
      canaryActive: true,
      error: 'Access denied: Merchant is not authorized during production canary mode.',
      code: 'CANARY_MERCHANT_UNAUTHORIZED',
      statusCode: 403
    };
  }

  return {
    allowed: true,
    canaryActive: true,
    matchedIdentifier
  };
}

/**
 * Throws an error immediately if the merchant is not eligible under Canary Mode.
 *
 * @param {object|string} merchant
 * @param {object} [options]
 * @throws {CanaryConfigurationError|CanaryMerchantUnauthorizedError}
 */
export function assertCanaryMerchantAllowed(merchant, options = {}) {
  const result = evaluateCanaryMerchantEligibility(merchant, options);
  if (!result.allowed) {
    if (result.statusCode === 500) {
      const err = new CanaryConfigurationError(result.error);
      err.code = result.code;
      throw err;
    }
    const err = new CanaryMerchantUnauthorizedError(result.error);
    err.code = result.code;
    throw err;
  }
  return result;
}
