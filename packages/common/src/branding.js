/**
 * Centralized White-Label Branding Configuration
 *
 * Configures customer-facing brand identity across checkout-portal,
 * payment-api, and banking observers.
 */
export const BRANDING_CONFIG = Object.freeze({
  businessName: 'V-Visa Business',
  poweredBy: 'Mitto Pay',
  appName: 'Mitto Pay',
  supportEmail: 'support@vvisa.in',
  supportEmails: Object.freeze(['support@vvisa.in']),
  supportPhone: '+91 8610648309',
  supportMobiles: Object.freeze(['+91 8610648309']),
  logoUrl: 'https://res.cloudinary.com/dc5dpnyoq/image/upload/v1792656583/20260330_visa_Logos_eiovjr.png',
  primaryColor: '#2563eb',
  sidebarNotice: 'Fast & Secure 256-Bit Bank Encryption',
  trustBadgeText: 'Verified Business · Powered by Mitto Pay',
  counterInstructions: 'Please visit the billing counter and present this screen to the cashier.',
  cardCounterInstructions: 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
});
