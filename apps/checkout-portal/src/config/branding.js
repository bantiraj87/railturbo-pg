/**
 * Checkout Portal Centralized Branding Configuration
 */
import { BRANDING_CONFIG as COMMON_BRANDING } from '@youpi/common';

export const BRANDING_CONFIG = Object.freeze({
  businessName: process.env.CHECKOUT_BUSINESS_NAME || COMMON_BRANDING.businessName,
  poweredBy: process.env.CHECKOUT_POWERED_BY || COMMON_BRANDING.poweredBy,
  appName: process.env.CHECKOUT_APP_NAME || COMMON_BRANDING.appName,
  supportEmail: process.env.CHECKOUT_SUPPORT_EMAIL || COMMON_BRANDING.supportEmail,
  supportEmails: Object.freeze(COMMON_BRANDING.supportEmails),
  supportPhone: process.env.CHECKOUT_SUPPORT_PHONE || COMMON_BRANDING.supportPhone,
  supportMobiles: Object.freeze(COMMON_BRANDING.supportMobiles),
  logoUrl: process.env.CHECKOUT_LOGO_URL || COMMON_BRANDING.logoUrl,
  primaryColor: process.env.CHECKOUT_PRIMARY_COLOR || COMMON_BRANDING.primaryColor,
  sidebarNotice: process.env.CHECKOUT_SIDEBAR_NOTICE || COMMON_BRANDING.sidebarNotice,
  trustBadgeText: COMMON_BRANDING.trustBadgeText,
  counterInstructions: COMMON_BRANDING.counterInstructions,
  cardCounterInstructions: COMMON_BRANDING.cardCounterInstructions,
});
