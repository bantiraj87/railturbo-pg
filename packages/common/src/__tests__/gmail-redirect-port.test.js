import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGmailRedirectUri } from '../runtime-config.js';

let saved;
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
function setEnv(key, value) { process.env[key] = value; }
function deleteEnv(key) { delete process.env[key]; }

test('localhost Gmail callback follows the configured observer listener port', () => {
  setEnv('YOUPI_MODE', 'localhost');
  setEnv('GMAIL_OBSERVER_PORT', '6203');
  deleteEnv('GMAIL_REDIRECT_URI');
  assert.equal(resolveGmailRedirectUri(), 'http://localhost:6203/oauth/callback');
});

test('explicit Gmail callback remains authoritative', () => {
  setEnv('YOUPI_MODE', 'localhost');
  setEnv('GMAIL_OBSERVER_PORT', '6203');
  setEnv('GMAIL_REDIRECT_URI', 'https://gmail.example.test/oauth/callback');
  assert.equal(resolveGmailRedirectUri(), 'https://gmail.example.test/oauth/callback');
});

test('production callback uses its public hostname, not the local listener port', () => {
  setEnv('YOUPI_MODE', 'production');
  setEnv('CLOUDFLARE_DOMAIN', 'example.test');
  setEnv('DEPLOYMENT_PREFIX', 'pay');
  setEnv('GMAIL_OBSERVER_PORT', '6203');
  deleteEnv('GMAIL_REDIRECT_URI');
  assert.equal(resolveGmailRedirectUri(), 'https://pay-gmail.example.test/oauth/callback');
});

test('default localhost callback remains on port 6003', () => {
  setEnv('YOUPI_MODE', 'localhost');
  deleteEnv('GMAIL_OBSERVER_PORT');
  deleteEnv('GMAIL_REDIRECT_URI');
  assert.equal(resolveGmailRedirectUri(), 'http://localhost:6003/oauth/callback');
});

test('explicit localhost branding also uses the configured listener port', () => {
  setEnv('YOUPI_MODE', 'production');
  setEnv('CLOUDFLARE_DOMAIN', 'example.test');
  setEnv('GMAIL_OBSERVER_PORT', '6203');
  deleteEnv('GMAIL_REDIRECT_URI');
  assert.equal(resolveGmailRedirectUri({ envMode: 'localhost' }), 'http://localhost:6203/oauth/callback');
});
