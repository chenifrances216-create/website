'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminTest123';

const { createApp } = require('../src/app');
const db = require('../src/db');

let server;
let base;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '0.0.0.0', resolve);
  });
  base = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

let counter = 0;
function nextUser() {
  counter += 1;
  return {
    name: `Mtumiaji ${counter}`,
    email: `mteja${counter}@ship.test`,
    phone: `0712${String(100000 + counter).slice(-6)}`,
    password: 'siri1234',
  };
}

async function call(route, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}/api${route}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

async function registerUser(extra = {}) {
  const user = nextUser();
  const res = await call('/auth/register', { method: 'POST', body: { ...user, ...extra } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { ...user, token: res.data.token, user: res.data.user };
}

async function adminToken() {
  const res = await call('/auth/login', {
    method: 'POST',
    body: { email: 'admin@test.local', password: 'AdminTest123' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.token;
}

test('msimamizi ameandaliwa na /api/config inapatikana', async () => {
  const res = await call('/config');
  assert.equal(res.status, 200);
  assert.equal(res.data.brand, 'Ship Transfer');
  assert.equal(res.data.packages.length, 5);
  assert.equal(res.data.minDeposit, 5000);
});

test('mtu mpya anajisajili kwa jina, namba, barua pepe na neno la siri', async () => {
  const account = await registerUser();
  assert.ok(account.token);
  assert.equal(account.user.balance, 1000);
  assert.equal(account.user.phone.startsWith('+255'), true);
  assert.match(account.user.referralCode, /^SHIP/);

  const me = await call('/me', { token: account.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, account.email);
});

test('usajili hukataa taarifa zisizo sahihi na barua pepe iliyotumika', async () => {
  const account = await registerUser();

  const duplicate = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Mwingine', email: account.email, phone: '0712999999', password: 'siri1234' },
  });
  assert.equal(duplicate.status, 409);

  const badPhone = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Mwingine', email: 'bad-phone@ship.test', phone: '123', password: 'siri1234' },
  });
  assert.equal(badPhone.status, 400);

  const shortPassword = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Mwingine', email: 'short@ship.test', phone: '0712888888', password: '123' },
  });
  assert.equal(shortPassword.status, 400);
});

test('login inafanya kazi kwa barua pepe na kwa namba ya simu', async () => {
  const account = await registerUser();

  const byEmail = await call('/auth/login', {
    method: 'POST',
    body: { email: account.email, password: account.password },
  });
  assert.equal(byEmail.status, 200);
  assert.ok(byEmail.data.token);

  const byPhone = await call('/auth/login', {
    method: 'POST',
    body: { email: account.phone, password: account.password },
  });
  assert.equal(byPhone.status, 200);

  const wrong = await call('/auth/login', {
    method: 'POST',
    body: { email: account.email, password: 'si-sahihi' },
  });
  assert.equal(wrong.status, 401);
});

test('/api/me inahitaji token', async () => {
  const res = await call('/me');
  assert.equal(res.status, 401);
});

test('amana inasubiri uthibitisho wa msimamizi kisha salio linaongezeka', async () => {
  const account = await registerUser();

  const deposit = await call('/deposit', {
    method: 'POST',
    token: account.token,
    body: { amount: 50000, method: 'M-Pesa', reference: 'MP123' },
  });
  assert.equal(deposit.status, 201);
  assert.equal(deposit.data.transaction.status, 'pending');
  assert.equal(deposit.data.user.balance, 1000);

  const admin = await adminToken();
  const overview = await call('/admin/overview', { token: admin });
  assert.equal(overview.status, 200);
  const request = overview.data.requests.find((r) => r.id === deposit.data.transaction.id);
  assert.ok(request, 'ombi linapaswa kuonekana kwa msimamizi');
  assert.equal(request.user.email, account.email);

  const approved = await call(`/admin/transactions/${request.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200);

  const me = await call('/me', { token: account.token });
  assert.equal(me.data.user.balance, 51000);
  assert.equal(me.data.user.totalDeposit, 50000);
});

test('mtumiaji wa kawaida hawezi kufikia API ya msimamizi', async () => {
  const account = await registerUser();
  const res = await call('/admin/overview', { token: account.token });
  assert.equal(res.status, 403);
});

test('utoaji hukata kiasi kwenye salio na kukataliwa hurudisha pesa', async () => {
  const account = await registerUser();
  const admin = await adminToken();

  const deposit = await call('/deposit', {
    method: 'POST',
    token: account.token,
    body: { amount: 100000, method: 'Airtel Money' },
  });
  await call(`/admin/transactions/${deposit.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });

  const tooMuch = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 500000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(tooMuch.status, 400);

  const belowMin = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 5000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(belowMin.status, 400);

  const withdraw = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 60000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(withdraw.status, 201);
  assert.equal(withdraw.data.user.balance, 41000);

  const rejected = await call(`/admin/transactions/${withdraw.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'reject', note: 'Namba si sahihi' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.user.balance, 101000);
});

test('uwekezaji wa VIP hupunguza salio na faida inaingia kila siku', async () => {
  const account = await registerUser();
  const admin = await adminToken();

  const deposit = await call('/deposit', {
    method: 'POST',
    token: account.token,
    body: { amount: 200000, method: 'M-Pesa' },
  });
  await call(`/admin/transactions/${deposit.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });

  const small = await call('/invest', {
    method: 'POST',
    token: account.token,
    body: { packageId: 'vip3', amount: 50000 },
  });
  assert.equal(small.status, 400, 'vip3 inahitaji kiasi cha chini zaidi');

  const invest = await call('/invest', {
    method: 'POST',
    token: account.token,
    body: { packageId: 'vip2', amount: 100000 },
  });
  assert.equal(invest.status, 201);
  assert.equal(invest.data.investment.dailyProfit, 2000);
  assert.equal(invest.data.user.balance, 101000);
  assert.equal(invest.data.user.vipLevel, 2);

  // Rudisha tarehe ya kuanza siku 3 nyuma ili faida itokee
  const state = db.getState();
  const stored = state.investments.find((i) => i.id === invest.data.investment.id);
  stored.startAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  db.commit();

  const me = await call('/me', { token: account.token });
  assert.equal(me.data.user.balance, 107000);
  assert.equal(me.data.user.totalProfit, 6000);

  const list = await call('/investments', { token: account.token });
  assert.equal(list.data.investments.length, 1);
  assert.equal(list.data.investments[0].daysPaid, 3);
});

test('mwaliko unampa mwalikaji bonasi na kuonekana kwenye orodha', async () => {
  const inviter = await registerUser();

  const friend = nextUser();
  const joined = await call('/auth/register', {
    method: 'POST',
    body: { ...friend, inviteCode: inviter.user.referralCode },
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.data.user.balance, 1500);

  const me = await call('/me', { token: inviter.token });
  assert.equal(me.data.user.balance, 3000);

  const invite = await call('/invite', { token: inviter.token });
  assert.equal(invite.data.totalInvited, 1);
  assert.equal(invite.data.totalEarned, 2000);
  assert.equal(invite.data.invited[0].name, friend.name);
});

test('historia inaonyesha muamala wa mtumiaji pekee', async () => {
  const first = await registerUser();
  const second = await registerUser();

  await call('/deposit', {
    method: 'POST',
    token: first.token,
    body: { amount: 20000, method: 'Halopesa' },
  });

  const firstHistory = await call('/transactions', { token: first.token });
  const secondHistory = await call('/transactions', { token: second.token });
  assert.equal(firstHistory.data.transactions.length, 2);
  assert.equal(secondHistory.data.transactions.length, 1);
  assert.equal(firstHistory.data.transactions[0].type, 'deposit');
  assert.equal(firstHistory.data.transactions[0].status, 'pending');
});

test('ukaguzi wa mabadiliko ya neno la siri', async () => {
  const account = await registerUser();

  const wrong = await call('/account/password', {
    method: 'POST',
    token: account.token,
    body: { currentPassword: 'si-sahihi', newPassword: 'mpya1234' },
  });
  assert.equal(wrong.status, 400);

  const changed = await call('/account/password', {
    method: 'POST',
    token: account.token,
    body: { currentPassword: account.password, newPassword: 'mpya1234' },
  });
  assert.equal(changed.status, 200);

  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: account.email, password: 'mpya1234' },
  });
  assert.equal(login.status, 200);
});

test('ukurasa wa mwanzo unahudumiwa na jina la kampuni', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Ship/);
  assert.match(html, /Jisajili/);
});

/* ---------------- Malipo ya simu: M-Pesa na Tigo Pesa ---------------- */
const payments = require('../src/payments');

test('config inaonyesha njia za malipo ya simu na hali ya sandbox', async () => {
  const res = await call('/config');
  assert.equal(res.status, 200);
  assert.equal(res.data.payments.mode, 'sandbox');
  assert.equal(res.data.payments.live, false);
  assert.ok(res.data.payments.mobileMethods.includes('M-Pesa'));
  assert.ok(res.data.payments.mobileMethods.includes('Tigo Pesa'));
});

test('payload ya malipo hutuma mtandao sahihi kwa kila mtandao', () => {
  const mpesa = payments.buildChargePayload({
    amount: 10000,
    email: 'asha@example.com',
    phone: '0712345678',
    method: 'M-Pesa',
    txRef: 'tx-1',
    name: 'Asha',
  });
  assert.equal(mpesa.network, 'VODACOM');
  assert.equal(mpesa.phone_number, '0712345678');
  assert.equal(mpesa.currency, 'TZS');

  const tigo = payments.buildChargePayload({
    amount: 5000,
    email: 'asha@example.com',
    phone: '+255712345678',
    method: 'Tigo Pesa',
    txRef: 'tx-2',
  });
  assert.equal(tigo.network, 'TIGO');
  assert.equal(tigo.phone_number, '0712345678');

  assert.throws(
    () => payments.buildChargePayload({ amount: 5000, email: 'a@b.c', phone: '123', method: 'M-Pesa', txRef: 'tx-3' }),
    /Namba ya simu/,
  );
});

test('amana ya M-Pesa: ombi la malipo, kisha salio linaingia mara moja', async () => {
  const { token } = await registerUser();
  const start = await call('/me', { token });
  const before = start.data.user.balance;

  const res = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 25000, method: 'M-Pesa', phone: '0712345678' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.transaction.status, 'pending');
  assert.equal(res.data.transaction.channel, 'mobile_money');
  assert.equal(res.data.payment.mode, 'sandbox');
  assert.match(res.data.transaction.providerRef, /^SBX-/);

  const done = await call(`/deposit/${res.data.transaction.id}/simulate`, { method: 'POST', token });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.transaction.status, 'completed');
  assert.equal(done.data.user.balance, before + 25000);

  const again = await call(`/deposit/${res.data.transaction.id}/simulate`, { method: 'POST', token });
  assert.equal(again.status, 200);
  assert.equal(again.data.credited, false);
  assert.equal(again.data.user.balance, before + 25000);
});

test('amana ya Tigo Pesa inahitaji namba ya simu sahihi', async () => {
  const { token } = await registerUser();
  const res = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 25000, method: 'Tigo Pesa', phone: '123' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /simu/i);
});

test('amana ya benki inabaki ya msimamizi na haiwezi kuigwa', async () => {
  const { token } = await registerUser();
  const res = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 30000, method: 'Benki', reference: 'CRDB-99' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.payment.status, 'manual');
  assert.equal(res.data.transaction.channel, 'manual');

  const sim = await call(`/deposit/${res.data.transaction.id}/simulate`, { method: 'POST', token });
  assert.equal(sim.status, 400);
});

test('webhook huhitaji sahihi na hulipia amana mara moja tu', async () => {
  const { token } = await registerUser();
  const created = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 15000, method: 'M-Pesa', phone: '0712345678' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const txnId = created.data.transaction.id;
  const before = created.data.user.balance;

  const payload = JSON.stringify({
    event: 'charge.completed',
    data: { id: 998877, tx_ref: txnId, status: 'successful', amount: 15000, currency: 'TZS' },
  });
  const hook = (hash) =>
    fetch(`${base}/api/payments/webhook/flutterwave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'verif-hash': hash },
      body: payload,
    });

  const bad = await hook('wrong-hash');
  assert.equal(bad.status, 401);

  process.env.FLW_WEBHOOK_HASH = 'test-hash-123';
  try {
    const ok = await hook('test-hash-123');
    assert.equal(ok.status, 200);
    const after = await call('/me', { token });
    assert.equal(after.data.user.balance, before + 15000);

    const dup = await hook('test-hash-123');
    assert.equal(dup.status, 200);
    const still = await call('/me', { token });
    assert.equal(still.data.user.balance, before + 15000);
  } finally {
    delete process.env.FLW_WEBHOOK_HASH;
  }
});

test('uigaji wa malipo huzuiwa pale funguo halisi zimewekwa', async () => {
  const { token } = await registerUser();
  const created = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 15000, method: 'Tigo Pesa', phone: '0712345678' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  process.env.FLW_SECRET_KEY = 'FLWSECK_TEST-dummy';
  try {
    const sim = await call(`/deposit/${created.data.transaction.id}/simulate`, { method: 'POST', token });
    assert.equal(sim.status, 403);
  } finally {
    delete process.env.FLW_SECRET_KEY;
  }
});

/* ---------------- Utoaji wa kiotomatiki (payout) ---------------- */

const payments = require('../src/payments');
const domain = require('../src/domain');

async function fundedUser(amount) {
  const account = await registerUser();
  const dep = await call('/deposit', {
    method: 'POST',
    token: account.token,
    body: { amount, method: 'M-Pesa', phone: account.phone },
  });
  assert.equal(dep.status, 201, JSON.stringify(dep.data));
  const sim = await call(`/deposit/${dep.data.transaction.id}/simulate`, {
    method: 'POST',
    token: account.token,
  });
  assert.equal(sim.status, 200, JSON.stringify(sim.data));
  return { ...account, balance: sim.data.user.balance };
}

test('payout payload hutumia mtandao sahihi na namba ya ndani', () => {
  const payload = payments.buildTransferPayload({
    amount: 25000,
    account: '+255712345678',
    method: 'Tigo Pesa',
    reference: 'ref-1',
    beneficiaryName: 'Neema',
  });
  assert.equal(payload.account_bank, 'TIGO');
  assert.equal(payload.account_number, '0712345678');
  assert.equal(payload.amount, 25000);
  assert.equal(payload.currency, 'TZS');
  assert.equal(payload.reference, 'ref-1');

  const mpesa = payments.buildTransferPayload({ amount: 9000, account: '0712345678', method: 'M-Pesa', reference: 'r2' });
  assert.equal(mpesa.account_bank, 'VODACOM');

  assert.throws(() => payments.buildTransferPayload({ amount: 5000, account: '0712345678', method: 'Benki', reference: 'r3' }));
  assert.throws(() => payments.buildTransferPayload({ amount: 5000, account: '12', method: 'M-Pesa', reference: 'r4' }));
  assert.throws(() => payments.buildTransferPayload({ amount: 0, account: '0712345678', method: 'M-Pesa', reference: 'r5' }));
});

test('utoaji wa simu hulipwa kiotomatiki msimamizi akikubali', async () => {
  const admin = await adminToken();
  const account = await fundedUser(60000);

  const created = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 20000, method: 'Tigo Pesa', account: account.phone },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.payout.automatic, true);
  assert.equal(created.data.user.balance, account.balance - 20000);

  const approved = await call(`/admin/transactions/${created.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.transaction.status, 'completed');
  assert.equal(approved.data.transaction.payoutStatus, 'completed');
  assert.equal(approved.data.transaction.channel, 'mobile_money');
  assert.equal(approved.data.payout.sandbox, true);

  const owner = db.getState().users.find((u) => u.id === account.user.id);
  assert.equal(owner.paidOut, 20000);

  const again = await call(`/admin/transactions/${created.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(again.status, 400);

  const status = await call(`/withdraw/${created.data.transaction.id}`, { token: account.token });
  assert.equal(status.status, 200);
  assert.equal(status.data.transaction.status, 'completed');
});

test('webhook ya utoaji hulipia mara moja tu', async () => {
  process.env.FLW_WEBHOOK_HASH = 'test-hash';
  try {
    const account = await fundedUser(50000);
    const created = await call('/withdraw', {
      method: 'POST',
      token: account.token,
      body: { amount: 15000, method: 'M-Pesa', account: account.phone },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const state = db.getState();
    const txn = state.transactions.find((t) => t.id === created.data.transaction.id);
    domain.startPayout(state, txn, { provider: 'flutterwave', providerRef: 'FLW-T-1' });
    db.commit();

    const body = JSON.stringify({
      event: 'transfer.completed',
      data: { id: 'FLW-T-1', reference: txn.id, status: 'SUCCESSFUL', amount: 15000 },
    });
    const send = () =>
      fetch(`${base}/api/payments/webhook/flutterwave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'verif-hash': 'test-hash' },
        body,
      });

    const first = await send();
    assert.equal(first.status, 200);
    const second = await send();
    assert.equal(second.status, 200);

    assert.equal(txn.status, 'completed');
    assert.equal(txn.meta.payoutStatus, 'completed');
    const owner = state.users.find((u) => u.id === account.user.id);
    assert.equal(owner.paidOut, 15000);
  } finally {
    delete process.env.FLW_WEBHOOK_HASH;
  }
});

test('webhook isiyo na sahihi haikubaliwi', async () => {
  const response = await fetch(`${base}/api/payments/webhook/flutterwave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'verif-hash': 'wrong' },
    body: JSON.stringify({ event: 'transfer.completed', data: { reference: 'hack', status: 'SUCCESSFUL' } }),
  });
  assert.equal(response.status, 401);
});

test('utoaji ukishindikana unarudi kwenye foleni', async () => {
  const account = await fundedUser(40000);
  const created = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 12000, method: 'M-Pesa', account: account.phone },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const state = db.getState();
  const txn = state.transactions.find((t) => t.id === created.data.transaction.id);
  domain.startPayout(state, txn, { provider: 'flutterwave', providerRef: 'FLW-T-2' });
  domain.failPayout(state, txn, 'Salio la mtoa huduma halitoshi');
  db.commit();

  const status = await call(`/withdraw/${txn.id}`, { token: account.token });
  assert.equal(status.status, 200);
  assert.equal(status.data.transaction.status, 'pending');
  assert.equal(status.data.transaction.payoutStatus, 'failed');
  assert.equal(status.data.transaction.failureReason, 'Salio la mtoa huduma halitoshi');
});

test('utoaji wa benki unabaki kwa idhini ya msimamizi', async () => {
  const admin = await adminToken();
  const account = await fundedUser(30000);
  const created = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 10000, method: 'Benki', account: 'CRDB 0150123456' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.payout.automatic, false);

  const approved = await call(`/admin/transactions/${created.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.transaction.status, 'completed');
  assert.equal(approved.data.transaction.channel, 'manual');
});
