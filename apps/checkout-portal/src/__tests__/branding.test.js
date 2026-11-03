import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutServer } from '../server.js';
import { BRANDING_CONFIG } from '../config/branding.js';

describe('White-Label Branding & Checkout Identity Tests', () => {
  const server = new CheckoutServer();

  test('renderHtml defaults to V-Visa Business and Mitto Pay branding when state is minimal/demo', () => {
    const html = server.renderHtml('test-payment-123', {
      orderId: 'ORD-999',
      amount: '500.00'
    });

    // 1. Page title must feature V-Visa Business and Mitto Pay
    assert.ok(html.includes('<title>V-Visa Business · Mitto Pay Checkout</title>'), 'Title must have V-Visa Business and Mitto Pay');

    // 2. Header and Sidebar merchant name
    assert.ok(html.includes('<div class="ypg-merchant-name" id="headerMerchantName">V-Visa Business</div>'), 'Header merchant name must be V-Visa Business');
    assert.ok(html.includes('<div class="ypg-pc-merchant-name" id="pcMerchantName">V-Visa Business</div>'), 'Sidebar merchant name must be V-Visa Business');

    // 3. Trust badge must state "Powered by Mitto Pay"
    assert.ok(html.includes('Verified Business · Powered by Mitto Pay'), 'Trust badge must be Powered by Mitto Pay');

    // 4. Logo URL must match official V-Visa asset
    assert.ok(html.includes(BRANDING_CONFIG.logoUrl), 'Rendered HTML must contain configured V-Visa logo URL');

    // 5. Customer support details must match V-Visa support
    assert.ok(html.includes(BRANDING_CONFIG.supportEmail), 'Rendered HTML must contain support@vvisa.in');
    assert.ok(html.includes(BRANDING_CONFIG.supportPhone), 'Rendered HTML must contain +91 8610648309');

    // 6. Splash screen and footer powered by text
    assert.ok(html.includes('<strong id="splashSecuredByText" style="color:var(--ypg-blue); font-size:15px; letter-spacing:-0.2px;">Mitto Pay</strong>'), 'Splash footer must say Mitto Pay');
    assert.ok(html.includes('Secured by Mitto Pay & 256-Bit Bank Encryption'), 'Footer must say Secured by Mitto Pay');

    // 7. Success & Processing wording
    assert.ok(html.includes('Processing payment securely with Mitto Pay'), 'Processing modal must state Mitto Pay');

    // 8. No customer-facing YouPI strings in rendered badges/titles
    assert.ok(!html.includes('YouPI PG Verified Business'), 'No YouPI PG Verified Business allowed');
    assert.ok(!html.includes('YouPI PG Trusted Business'), 'No YouPI PG Trusted Business allowed');
    assert.ok(!html.includes('YouPI PG Help &amp; Support'), 'No YouPI PG Help & Support allowed');
  });

  test('renderHtml preserves custom merchant branding when merchant supplies their own brand', () => {
    const html = server.renderHtml('custom-payment-456', {
      merchantName: 'Acme Corp',
      branding: {
        appName: 'Acme Gateway',
        logoUrl: 'https://example.com/logo.png',
        primaryColor: '#ff0000',
        supportEmails: ['help@acme.com'],
        supportMobiles: ['+91 9999999999']
      }
    });

    assert.ok(html.includes('<title>Acme Corp · Acme Gateway Checkout</title>'));
    assert.ok(html.includes('Acme Corp'));
    assert.ok(html.includes('https://example.com/logo.png'));
    assert.ok(html.includes('help@acme.com'));
  });
});
