import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Authoritative environment variables
process.env.NODE_ENV = 'production';
process.env.YOUPI_MODE = 'localhost';
process.env.YOUPI_ALLOW_LOCALHOST_MODE = 'true';
process.env.YOUPI_BIND_HOST = '127.0.0.1';
process.env.USE_SQLITE_FALLBACK = 'true';

// Master gateway port (Render injects PORT, default to 10000)
const MASTER_PORT = Number(process.env.PORT || 10000);
const INTERNAL_API_PORT = 6100;
const INTERNAL_CHECKOUT_PORT = 7000;
const INTERNAL_ADMIN_PORT = 6001;

console.log('====================================================');
console.log('🚀 RAILTURBO 24/7 CLOUD UPI PAYMENT GATEWAY');
console.log('====================================================');

// 1. Initialize DB and RailTurbo Merchant Configuration
import {
  getDatabase,
  runMigrations,
  ensureDatabaseInitialized,
  MerchantRepository,
  ReceivingAccountRepository
} from '../packages/db/src/index.js';

console.log('[1/4] Initializing Database & Tatkal VIP Merchant...');
const db = getDatabase();
ensureDatabaseInitialized(db);
runMigrations(db);

const merchantRepo = new MerchantRepository(db);
const accountRepo = new ReceivingAccountRepository(db);

const defaultMerchantId = '00000000-0000-0000-0000-000000000001';
const businessName = process.env.DEFAULT_MERCHANT_NAME || 'RailTurbo Tatkal Autofill';
const webhookUrl = process.env.DEFAULT_WEBHOOK_URL || 'https://railturbo-vip.vercel.app/api/paytm-webhook';
const upiId = process.env.DEFAULT_UPI_ID || '8102167310@sbi';
const payeeName = process.env.DEFAULT_PAYEE_NAME || 'RailTurbo VIP';

const merchant = merchantRepo.findById(defaultMerchantId);
if (merchant) {
  merchantRepo.update(defaultMerchantId, {
    businessName,
    webhookUrl
  });
  console.log(`[✓] Merchant Configured: ${businessName} (Webhook: ${webhookUrl})`);
}

const accounts = accountRepo.findByMerchantId(defaultMerchantId);
if (accounts.length > 0) {
  db.execute(`
    UPDATE payment_receiving_accounts
    SET upi_id = ?, payee_name = ?, is_active = 1, updated_at = ?
    WHERE id = ?
  `, [upiId, payeeName, new Date().toISOString(), accounts[0].id]);
  console.log(`[✓] Receiving UPI Account: ${upiId} (${payeeName})`);
} else {
  accountRepo.create({
    merchantId: defaultMerchantId,
    upiId,
    payeeName,
    isActive: true
  });
  console.log(`[✓] Created Receiving UPI Account: ${upiId} (${payeeName})`);
}

// 2. Start internal services on loopback
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';
import { startAdminServer } from '../apps/merchant-admin/src/index.js';

console.log('[2/4] Starting Payment Core API on internal port 6100...');
const paymentService = await startPaymentApi(INTERNAL_API_PORT, db);

console.log('[3/4] Starting Checkout Portal on internal port 7000...');
const checkoutService = await startCheckoutServer(INTERNAL_CHECKOUT_PORT);

console.log('[4/4] Starting Merchant Admin Hub on internal port 6001...');
const adminService = await startAdminServer(INTERNAL_ADMIN_PORT, { db });

// Helper to proxy requests to internal port
function proxyRequest(targetPort, req, res) {
  const headers = { ...req.headers };
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  delete headers.connection;

  const isStream = req.url.includes('/stream');
  if (isStream) {
    if (req.socket) req.socket.setTimeout(0);
    if (res.socket) res.socket.setTimeout(0);
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers
    },
    (proxyRes) => {
      // Add CORS headers for API calls
      const resHeaders = { ...proxyRes.headers };
      resHeaders['access-control-allow-origin'] = '*';
      resHeaders['access-control-allow-headers'] = 'Content-Type, Authorization, X-Device-Id, X-Signature, X-Timestamp, X-Merchant-Id, Idempotency-Key';
      resHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway upstream unavailable', details: err.message }));
    }
  });

  req.pipe(proxyReq);
}

// 3. Create Master Unified HTTP Server on PORT
const masterServer = http.createServer((req, res) => {
  // CORS preflight support
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Signature, X-Timestamp, X-Merchant-Id, Idempotency-Key'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Health check endpoint for Render / Uptime monitors
  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      service: 'railturbo-upi-gateway',
      merchant: businessName,
      upi: upiId,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 1. Payment API & Observer Endpoints (Android App, Webhook, Payment Creation)
  if (pathname.startsWith('/api/')) {
    return proxyRequest(INTERNAL_API_PORT, req, res);
  }

  // 2. Checkout Portal & Assets
  if (
    pathname.startsWith('/checkout') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/css/') ||
    pathname.startsWith('/js/') ||
    pathname.startsWith('/fonts/')
  ) {
    return proxyRequest(INTERNAL_CHECKOUT_PORT, req, res);
  }

  // 3. Merchant Admin Hub (Default)
  return proxyRequest(INTERNAL_ADMIN_PORT, req, res);
});

masterServer.listen(MASTER_PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log(`🟢 RAILTURBO UNIFIED CLOUD GATEWAY ACTIVE ON PORT ${MASTER_PORT}`);
  console.log(`• Health Check:     http://0.0.0.0:${MASTER_PORT}/health`);
  console.log(`• Payment API:      http://0.0.0.0:${MASTER_PORT}/api/v1/...`);
  console.log(`• Checkout Portal:  http://0.0.0.0:${MASTER_PORT}/checkout/:id`);
  console.log(`• Merchant Admin:   http://0.0.0.0:${MASTER_PORT}/`);
  console.log('====================================================');
});
