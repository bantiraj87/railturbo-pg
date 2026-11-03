import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmailPoller } from '../gmail-poller.js';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-stop-'));
  const poller = new GmailPoller({ receivingAccountId: 'synthetic-account', storagePath: path.join(directory, 'ids.json') });
  poller.setCredentials({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' });
  poller.pollCycle = async () => {};
  t.after(() => { poller.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return poller;
}

for (const token of ['synthetic-token', null]) {
  test(`stop wins over a pending ${token ? 'successful' : 'failed'} token check`, async (t) => {
    const poller = setup(t);
    let finish;
    poller.getAccessToken = () => new Promise(resolve => { finish = resolve; });
    const boot = poller.startBootLifecycle();
    poller.stop();
    finish(token);
    const result = await boot;
    assert.equal(result.success, false);
    assert.equal(poller.isRunning, false);
    assert.equal(poller.lifecycleState, 'STOPPED');
    assert.equal(poller.timer, null);
    assert.equal(poller.bootRetryTimer, null);
  });
}

test('stop wins over a pending credential lookup without scheduling a retry', async (t) => {
  const poller = setup(t);
  poller.credentials = null;
  let finish;
  poller.fetchCredentialsFromPaymentApi = () => new Promise(resolve => { finish = resolve; });
  const boot = poller.startBootLifecycle();
  poller.stop();
  finish();
  const result = await boot;
  assert.equal(result.success, false);
  assert.equal(poller.lifecycleState, 'STOPPED');
  assert.equal(poller.bootRetryTimer, null);
});

test('an older boot cannot degrade a newer successful restart', async (t) => {
  const poller = setup(t);
  let finish;
  poller.getAccessToken = () => new Promise(resolve => { finish = resolve; });
  const oldBoot = poller.startBootLifecycle();
  poller.stop();
  poller.getAccessToken = async () => 'new-token';
  assert.equal((await poller.startBootLifecycle()).success, true);
  finish(null);
  await oldBoot;
  assert.equal(poller.lifecycleState, 'ACTIVE');
  assert.equal(poller.isRunning, true);
  assert.equal(poller.bootRetryTimer, null);
});

test('an HTTP stop response remains stopped after the earlier start request completes', async (t) => {
  const { GmailObserverServer } = await import('../server.js');
  const { getAdminToken } = await import('@youpi/common');
  const poller = setup(t);
  let finish;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  poller.getAccessToken = () => new Promise(resolve => { finish = resolve; markStarted(); });
  const server = new GmailObserverServer({ poller }).createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { method: 'POST', headers: { Authorization: `Bearer ${getAdminToken()}` } };
  const start = fetch(`${base}/control/start`, options);
  await started;
  const stopped = await fetch(`${base}/control/stop`, options);
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).lifecycleState, 'STOPPED');
  finish('synthetic-token');
  assert.equal((await start).status, 200);
  const health = await fetch(`${base}/health`);
  const state = await health.json();
  assert.equal(state.lifecycleState, 'STOPPED');
  assert.equal(state.isRunning, false);
});
