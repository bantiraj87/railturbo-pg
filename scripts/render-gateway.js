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
process.env.YOUPI_ENFORCE_OBSERVER_HEALTH = 'false';

// Master gateway port (Render injects PORT, default to 10000)
const MASTER_PORT = Number(process.env.PORT || 10000);
const INTERNAL_API_PORT = 6100;
const INTERNAL_CHECKOUT_PORT = 7000;
const INTERNAL_ADMIN_PORT = 6001;

console.log('====================================================');
console.log('🚀 RAILTURBO 24/7 CLOUD UPI PAYMENT GATEWAY & DATABASE');
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
const businessName = 'RailTurbo Tatkal Autofill';
const webhookUrl = 'https://railturbo-vip.vercel.app/api/paytm-webhook';
const upiId = '8102167310@sbi';
const payeeName = 'RailTurbo VIP';

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

// -------------------------------------------------------------
// RAILTURBO PERSISTENT SQLITE STORAGE (ZERO VERCEL BLOB LIMITS)
// -------------------------------------------------------------
db.execute(`
  CREATE TABLE IF NOT EXISTS railturbo_orders (
    order_id TEXT PRIMARY KEY,
    plan TEXT,
    amount REAL,
    device_id TEXT,
    status TEXT,
    key TEXT,
    txn_id TEXT,
    created_at TEXT,
    updated_at TEXT
  );
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS railturbo_keys (
    key TEXT PRIMARY KEY,
    plan TEXT,
    order_id TEXT,
    device_id TEXT,
    device_info TEXT,
    is_redeemed INTEGER DEFAULT 0,
    claimed_by_extension INTEGER DEFAULT 0,
    created_at TEXT,
    activated_at TEXT
  );
`);

try { db.execute('ALTER TABLE railturbo_keys ADD COLUMN device_info TEXT'); } catch {}
try { db.execute('ALTER TABLE railturbo_keys ADD COLUMN activated_at TEXT'); } catch {}

// Seed initial orders if empty
try {
  const existingOrder = db.queryOne('SELECT count(*) as cnt FROM railturbo_orders');
  if (!existingOrder || existingOrder.cnt === 0) {
    const now = new Date().toISOString();
    db.execute(`
      INSERT OR REPLACE INTO railturbo_orders (order_id, plan, amount, device_id, status, key, txn_id, created_at, updated_at)
      VALUES ('RT713679UYY1', '1day', 19, 'DEV-K461T0S', 'PAID', 'TURBO-1D-GR6AEY', '667978727984', ?, ?)
    `, [now, now]);
    db.execute(`
      INSERT OR REPLACE INTO railturbo_keys (key, plan, order_id, device_id, is_redeemed, claimed_by_extension, created_at)
      VALUES ('TURBO-1D-GR6AEY', '1day', 'RT713679UYY1', NULL, 0, 0, ?)
    `, [now]);
  }
} catch (seedErr) {
  console.warn('Seed warning:', seedErr.message);
}

function makeKey(plan) {
  const prefix = plan === '1year' ? 'TURBO-1Y' : (plan === '5pack' ? 'TURBO-5P' : 'TURBO-1D');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}-${suffix}`;
}

function rtCreateOrder(orderData) {
  const existing = db.queryOne('SELECT * FROM railturbo_orders WHERE order_id = ?', [orderData.orderId]);
  if (existing) {
    return {
      orderId: existing.order_id,
      plan: existing.plan,
      amount: existing.amount,
      deviceId: existing.device_id,
      status: existing.status,
      key: existing.key,
      txnId: existing.txn_id,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at
    };
  }
  const now = new Date().toISOString();
  db.execute(`
    INSERT INTO railturbo_orders (order_id, plan, amount, device_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'PENDING', ?, ?)
  `, [orderData.orderId, orderData.plan || '1day', orderData.amount || 19, orderData.deviceId || null, now, now]);
  return {
    orderId: orderData.orderId,
    plan: orderData.plan || '1day',
    amount: orderData.amount || 19,
    deviceId: orderData.deviceId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    key: null
  };
}

function rtGetOrder(orderId) {
  const row = db.queryOne('SELECT * FROM railturbo_orders WHERE order_id = ?', [orderId]);
  if (!row) return null;
  return {
    orderId: row.order_id,
    plan: row.plan,
    amount: row.amount,
    deviceId: row.device_id,
    status: row.status,
    key: row.key,
    txnId: row.txn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rtGetAllOrders() {
  const rows = db.query('SELECT * FROM railturbo_orders ORDER BY created_at DESC');
  return rows.map(r => ({
    orderId: r.order_id,
    plan: r.plan,
    amount: r.amount,
    deviceId: r.device_id,
    status: r.status,
    key: r.key,
    txnId: r.txn_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

function rtMarkOrderPaid(orderId, txnId = 'CONFIRMED') {
  let order = rtGetOrder(orderId);
  if (!order) {
    order = rtCreateOrder({ orderId, plan: '1day', amount: 19 });
  }
  if (order.status !== 'PAID') {
    const key = makeKey(order.plan);
    const now = new Date().toISOString();
    db.execute(`
      UPDATE railturbo_orders
      SET status = 'PAID', txn_id = ?, key = ?, updated_at = ?
      WHERE order_id = ?
    `, [txnId, key, now, orderId]);

    db.execute(`
      INSERT OR REPLACE INTO railturbo_keys (key, plan, order_id, device_id, is_redeemed, claimed_by_extension, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, ?)
    `, [key, order.plan, orderId, now]);

    order.status = 'PAID';
    order.key = key;
    order.txnId = txnId;
    order.updatedAt = now;
  }
  return order;
}

function rtRedeemKey(key, deviceId, deviceInfo = null) {
  const row = db.queryOne('SELECT * FROM railturbo_keys WHERE key = ?', [key]);
  const now = new Date().toISOString();
  if (row) {
    if (row.device_id === deviceId) {
      if (deviceInfo && !row.device_info) {
        db.execute('UPDATE railturbo_keys SET device_info = ? WHERE key = ?', [deviceInfo, key]);
      }
      return { valid: true, plan: row.plan, key };
    }
    if (!row.claimed_by_extension || row.device_id === 'TEST_DEVICE_EXTENSION_1') {
      db.execute(`
        UPDATE railturbo_keys
        SET device_id = ?, device_info = ?, is_redeemed = 1, claimed_by_extension = 1, activated_at = ?
        WHERE key = ?
      `, [deviceId, deviceInfo || 'Desktop Browser', now, key]);
      return { valid: true, plan: row.plan, key };
    }
    if (row.device_id && row.device_id !== deviceId) {
      return { valid: false, error: 'Yeh key pehle se dusre computer / browser par use ho chuki hai!' };
    }
    db.execute(`
      UPDATE railturbo_keys
      SET device_id = ?, device_info = ?, is_redeemed = 1, claimed_by_extension = 1, activated_at = ?
      WHERE key = ?
    `, [deviceId, deviceInfo || 'Desktop Browser', now, key]);
    return { valid: true, plan: row.plan, key };
  }

  if (/^TURBO-(1D|5P|1Y)-[A-Z0-9]{5,8}$/.test(key)) {
    let plan = '1day';
    if (key.startsWith('TURBO-5P')) plan = '5pack';
    if (key.startsWith('TURBO-1Y')) plan = '1year';
    db.execute(`
      INSERT OR REPLACE INTO railturbo_keys (key, plan, order_id, device_id, device_info, is_redeemed, claimed_by_extension, created_at, activated_at)
      VALUES (?, ?, 'OFFLINE', ?, ?, 1, 1, ?, ?)
    `, [key, plan, deviceId, deviceInfo || 'Desktop Browser', now, now]);
    return { valid: true, plan, key };
  }

  return { valid: false, error: 'Invalid License Key!' };
}

function rtGetAllKeys() {
  const rows = db.query('SELECT * FROM railturbo_keys ORDER BY created_at DESC');
  return rows.map(r => ({
    key: r.key,
    plan: r.plan,
    orderId: r.order_id,
    deviceId: r.device_id,
    deviceInfo: r.device_info,
    isRedeemed: Boolean(r.is_redeemed),
    claimedByExtension: Boolean(r.claimed_by_extension),
    createdAt: r.created_at,
    activatedAt: r.activated_at
  }));
}

function rtResetKey(key) {
  db.execute(`
    UPDATE railturbo_keys
    SET device_id = NULL, device_info = NULL, is_redeemed = 0, claimed_by_extension = 0, activated_at = NULL
    WHERE key = ?
  `, [key]);
  return true;
}

function rtGenerateManualKey(plan) {
  const key = makeKey(plan);
  const now = new Date().toISOString();
  db.execute(`
    INSERT INTO railturbo_keys (key, plan, order_id, device_id, device_info, is_redeemed, claimed_by_extension, created_at)
    VALUES (?, ?, 'MANUAL', NULL, NULL, 0, 0, ?)
  `, [key, plan, now]);
  return key;
}

function rtClearPending() {
  db.execute("DELETE FROM railturbo_orders WHERE status != 'PAID'");
  return rtGetAllOrders();
}

function rtGetRecentObservations() {
  try {
    const rows = db.query('SELECT * FROM payment_observations ORDER BY observed_at DESC LIMIT 50');
    return rows.map(r => ({
      id: r.id,
      amount: r.amount_paise / 100,
      utr: r.bank_reference_number,
      sender: r.sender_vpa,
      status: r.attribution_status,
      time: r.observed_at
    }));
  } catch {
    return [];
  }
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

async function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// 3. Create Master Unified HTTP Server on PORT
const masterServer = http.createServer(async (req, res) => {
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

  // -----------------------------------------------------------
  // Dedicated RailTurbo Persistent Cloud DB API (Zero Rate Limits)
  // -----------------------------------------------------------
  if (pathname.startsWith('/api/v1/railturbo/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');

    const action = pathname.replace('/api/v1/railturbo/', '').replace(/\/$/, '');

    if (action === 'orders') {
      const orders = rtGetAllOrders();
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, count: orders.length, orders }));
    }

    if (action === 'keys') {
      const keys = rtGetAllKeys();
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, count: keys.length, keys }));
    }

    if (action === 'order') {
      const orderId = url.searchParams.get('orderId');
      const order = orderId ? rtGetOrder(orderId) : null;
      res.writeHead(200);
      return res.end(JSON.stringify({ success: !!order, order }));
    }

    if (action === 'observations') {
      const observations = rtGetRecentObservations();
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, count: observations.length, observations }));
    }

    if (req.method === 'POST') {
      const body = await parseJsonBody(req);

      if (action === 'create-order') {
        const order = rtCreateOrder(body);
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, order }));
      }

      if (action === 'mark-paid') {
        const order = rtMarkOrderPaid(body.orderId, body.txnId || 'CONFIRMED');
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, order }));
      }

      if (action === 'redeem-key') {
        const result = rtRedeemKey(body.key, body.deviceId, body.deviceInfo);
        res.writeHead(result.valid ? 200 : 400);
        return res.end(JSON.stringify(result));
      }

      if (action === 'reset-key') {
        const ok = rtResetKey(body.key);
        res.writeHead(200);
        return res.end(JSON.stringify({ success: ok, message: ok ? `Key ${body.key} reset successfully` : 'Key not found' }));
      }

      if (action === 'clear-pending') {
        const remaining = rtClearPending();
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, count: remaining.length, orders: remaining }));
      }

      if (action === 'manual-key') {
        const key = rtGenerateManualKey(body.plan || '1day');
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, key }));
      }
    }

    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'RailTurbo route not found' }));
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
  console.log(`• RailTurbo DB:     http://0.0.0.0:${MASTER_PORT}/api/v1/railturbo/...`);
  console.log(`• Payment API:      http://0.0.0.0:${MASTER_PORT}/api/v1/...`);
  console.log(`• Checkout Portal:  http://0.0.0.0:${MASTER_PORT}/checkout/:id`);
  console.log(`• Merchant Admin:   http://0.0.0.0:${MASTER_PORT}/`);
  console.log('====================================================');
});
