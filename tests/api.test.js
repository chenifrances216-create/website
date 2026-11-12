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
const domain = require('../src/domain');
const payments = require('../src/payments');
const { PACKAGES } = require('../src/constants');

let server;
let base;

// Fixed clock: Monday 12:00 EAT (inside the withdrawal window)
const DAY_MS = 24 * 60 * 60 * 1000;
const MONDAY = Date.parse('2026-11-16T09:00:00.000Z');

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

test.beforeEach(() => {
  domain.setClock(() => MONDAY);
});

test.afterEach(() => {
  domain.setClock(null);
});

let counter = 0;
function nextUser() {
  counter += 1;
  return {
    phone: `0712${String(100000 + counter).slice(-6)}`,
    password: 'secret1234',
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

// Mobile-money deposit that completes through the sandbox
async function mobileDeposit(token, amount) {
  const res = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount, method: 'M-Pesa', phone: '0712345678' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const done = await call(`/deposit/${res.data.transaction.id}/simulate`, { method: 'POST', token });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return done.data;
}

// Member who rented a ship and already earned `businessDays` of profit
async function memberWithProfit(level = 5, businessDays = 5) {
  const pkg = PACKAGES[level - 1];
  const account = await registerUser();
  await mobileDeposit(account.token, pkg.capital);

  const invest = await call('/invest', {
    method: 'POST',
    token: account.token,
    body: { packageId: pkg.id, amount: pkg.capital },
  });
  assert.equal(invest.status, 201, JSON.stringify(invest.data));

  const state = db.getState();
  const stored = state.investments.find((i) => i.id === invest.data.investment.id);
  stored.startAt = new Date(MONDAY).toISOString();
  db.commit();

  // Monday + 7 days = 5 business days counted, and the window is open again
  domain.setClock(() => MONDAY + 7 * DAY_MS);
  const me = await call('/me', { token: account.token });
  domain.setClock(() => MONDAY);

  return { ...account, pkg, balance: me.data.user.balance, investmentId: stored.id };
}

/* ------------------------- levels, auth and deposits ------------------------- */

test('config exposes the 13 ship levels and the withdrawal rules', async () => {
  const res = await call('/config');
  assert.equal(res.status, 200);
  assert.equal(res.data.brand, 'Ship Transfer');
  assert.equal(res.data.packages.length, 13);
  assert.equal(res.data.minDeposit, 5000);
  assert.equal(res.data.minWithdraw, 3000);
  assert.equal(res.data.referralRate, 0.1);
  assert.equal(res.data.withdrawOptions.length, 5);
  assert.equal(res.data.withdrawal.days, 'Monday - Friday');
  assert.equal(res.data.withdrawal.openAt, '10:00');
  assert.equal(res.data.withdrawal.closeAt, '17:00');
  assert.equal(res.data.withdrawal.open, true, 'Monday 12:00 EAT is inside the window');

  const first = res.data.packages[0];
  const last = res.data.packages[12];
  assert.equal(first.capital, 10000);
  assert.equal(first.dailyProfit, 500);
  assert.equal(first.image, '/img/ships/level-1.svg');
  assert.equal(last.capital, 1000000);
  assert.equal(last.dailyProfit, 37000);

  const table = res.data.packages.map((p) => [p.capital, p.dailyProfit]);
  assert.deepEqual(table, [
    [10000, 500],
    [20000, 1000],
    [30000, 1500],
    [60000, 2000],
    [100000, 3000],
    [200000, 5000],
    [300000, 7000],
    [400000, 8000],
    [600000, 15000],
    [700000, 20000],
    [800000, 25000],
    [900000, 30000],
    [1000000, 37000],
  ]);
});

test('a new member registers with a phone number and password', async () => {
  const account = await registerUser();
  assert.ok(account.token);
  assert.equal(account.user.balance, 1000);
  assert.equal(account.user.capital, 0);
  assert.equal(account.user.phone.startsWith('+255'), true);
  assert.match(account.user.referralCode, /^SHIP/);

  const me = await call('/me', { token: account.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.phone, account.user.phone);
  assert.equal(me.data.user.email, undefined);
});

test('registration rejects invalid details and a used phone number', async () => {
  const account = await registerUser();

  const duplicate = await call('/auth/register', {
    method: 'POST',
    body: { phone: account.user.phone, password: 'secret1234' },
  });
  assert.equal(duplicate.status, 409);

  const badPhone = await call('/auth/register', {
    method: 'POST',
    body: { phone: '123', password: 'secret1234' },
  });
  assert.equal(badPhone.status, 400);

  const shortPassword = await call('/auth/register', {
    method: 'POST',
    body: { phone: '0712888888', password: '123' },
  });
  assert.equal(shortPassword.status, 400);
});

test('login works with the phone number and rejects a wrong password', async () => {
  const account = await registerUser();

  const byPhone = await call('/auth/login', {
    method: 'POST',
    body: { phone: account.phone, password: account.password },
  });
  assert.equal(byPhone.status, 200);
  assert.ok(byPhone.data.token);

  const wrong = await call('/auth/login', {
    method: 'POST',
    body: { phone: account.phone, password: 'wrong-password' },
  });
  assert.equal(wrong.status, 401);
});

test('/api/me needs a token', async () => {
  const res = await call('/me');
  assert.equal(res.status, 401);
});

test('an approved deposit becomes locked capital, not withdrawable profit', async () => {
  const account = await registerUser();

  const deposit = await call('/deposit', {
    method: 'POST',
    token: account.token,
    body: { amount: 50000, method: 'Benki', reference: 'CRDB-1' },
  });
  assert.equal(deposit.status, 201);
  assert.equal(deposit.data.transaction.status, 'pending');

  const admin = await adminToken();
  const overview = await call('/admin/overview', { token: admin });
  const request = overview.data.requests.find((r) => r.id === deposit.data.transaction.id);
  assert.ok(request, 'the request should reach the admin queue');
  assert.equal(request.user.phone, account.user.phone);

  const approved = await call(`/admin/transactions/${request.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200);

  const me = await call('/me', { token: account.token });
  assert.equal(me.data.user.capital, 50000);
  assert.equal(me.data.user.balance, 1000, 'only the welcome bonus is profit');
  assert.equal(me.data.user.totalDeposit, 50000);
});

test('a normal member cannot reach the admin API', async () => {
  const account = await registerUser();
  const res = await call('/admin/overview', { token: account.token });
  assert.equal(res.status, 403);
});

/* --------------------------- withdrawal business rules --------------------------- */

test('capital can never be withdrawn', async () => {
  const account = await registerUser();
  await mobileDeposit(account.token, 50000);

  const res = await call('/withdraw', {
    method: 'POST',
    token: account.token,
    body: { amount: 30000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /profit/i);
  assert.match(res.data.error, /capital/i);
});

test('withdrawals are closed on Saturday, Sunday and outside 10:00-17:00', async () => {
  const account = await registerUser();
  await mobileDeposit(account.token, 50000);

  const attempt = () =>
    call('/withdraw', {
      method: 'POST',
      token: account.token,
      body: { amount: 3000, method: 'M-Pesa', account: '0712345678' },
    });

  // Saturday 12:00 EAT
  domain.setClock(() => MONDAY + 5 * DAY_MS);
  const saturday = await attempt();
  assert.equal(saturday.status, 400);
  assert.match(saturday.data.error, /Monday/i);

  // Sunday 12:00 EAT
  domain.setClock(() => MONDAY + 6 * DAY_MS);
  const sunday = await attempt();
  assert.equal(sunday.status, 400);

  // Monday 06:00 EAT (before opening)
  domain.setClock(() => MONDAY - 6 * 60 * 60 * 1000);
  const early = await attempt();
  assert.equal(early.status, 400);
  assert.match(early.data.error, /10:00/);

  // Monday 18:00 EAT (after closing)
  domain.setClock(() => MONDAY + 6 * 60 * 60 * 1000);
  const late = await attempt();
  assert.equal(late.status, 400);
  assert.match(late.data.error, /17:00/);

  domain.setClock(() => MONDAY);
  const open = await attempt();
  assert.equal(open.status, 400, 'still refused: the member has no profit yet');
  assert.match(open.data.error, /profit/i);
});

test('the minimum withdrawal is 3,000', async () => {
  const member = await memberWithProfit(5, 5);

  const below = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 2999, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(below.status, 400);

  const ok = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 3000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});

test('withdrawing profit charges 10% and approval pays the net amount', async () => {
  const admin = await adminToken();
  const member = await memberWithProfit(5, 5); // 15,000 profit + 1,000 bonus
  assert.equal(member.balance, 16000);

  const created = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 15000, method: 'Tigo Pesa', account: member.phone },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.payout.fee, 1500);
  assert.equal(created.data.payout.net, 13500);
  assert.equal(created.data.payout.automatic, true);
  assert.equal(created.data.user.balance, 1000);

  const approved = await call(`/admin/transactions/${created.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.transaction.status, 'completed');
  assert.equal(approved.data.transaction.payoutStatus, 'completed');

  const owner = db.getState().users.find((u) => u.id === member.user.id);
  assert.equal(owner.paidOut, 13500, 'only the net amount leaves the account');

  const again = await call(`/admin/transactions/${created.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'approve' },
  });
  assert.equal(again.status, 400, 'a payout is never repeated');
});

test('a rejected withdrawal returns the profit to the member', async () => {
  const admin = await adminToken();
  const member = await memberWithProfit(5, 5);

  const created = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 10000, method: 'M-Pesa', account: member.phone },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.balance, 6000);

  const rejected = await call(`/admin/transactions/${created.data.transaction.id}/decision`, {
    method: 'POST',
    token: admin,
    body: { action: 'reject', note: 'Wrong number' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.user.balance, 16000);
});

/* ------------------------------ ships and profit ------------------------------ */

test('renting a ship needs the exact capital of that level', async () => {
  const account = await registerUser();
  await mobileDeposit(account.token, 100000);

  const wrongAmount = await call('/invest', {
    method: 'POST',
    token: account.token,
    body: { packageId: 'ship5', amount: 90000 },
  });
  assert.equal(wrongAmount.status, 400);

  const invested = await call('/invest', {
    method: 'POST',
    token: account.token,
    body: { packageId: 'ship5', amount: 100000 },
  });
  assert.equal(invested.status, 201, JSON.stringify(invested.data));
  assert.equal(invested.data.investment.dailyProfit, 3000);
  assert.equal(invested.data.investment.image, '/img/ships/level-5.svg');
  assert.equal(invested.data.user.capital, 0);
  assert.equal(invested.data.user.vipLevel, 5);

  const list = await call('/investments', { token: account.token });
  assert.equal(list.data.investments.length, 1);
});

test('profit starts after 24 hours and skips Saturday and Sunday', async () => {
  const account = await registerUser();
  await mobileDeposit(account.token, 100000);
  const invested = await call('/invest', {
    method: 'POST',
    token: account.token,
    body: { packageId: 'ship5', amount: 100000 },
  });
  assert.equal(invested.status, 201, JSON.stringify(invested.data));

  const state = db.getState();
  const stored = state.investments.find((i) => i.id === invested.data.investment.id);
  stored.startAt = new Date(MONDAY).toISOString();
  db.commit();

  const balanceAt = async (offsetMs) => {
    domain.setClock(() => MONDAY + offsetMs);
    const me = await call('/me', { token: account.token });
    return me.data.user;
  };

  // 12 hours after renting: nothing yet
  const halfDay = await balanceAt(12 * 60 * 60 * 1000);
  assert.equal(halfDay.balance, 1000);

  // Tuesday 12:00 EAT: first business day paid
  const tuesday = await balanceAt(DAY_MS);
  assert.equal(tuesday.balance, 4000);
  assert.equal(tuesday.totalProfit, 3000);

  // Saturday 12:00 EAT: Tue, Wed, Thu, Fri = 4 days, weekend adds nothing
  const saturday = await balanceAt(5 * DAY_MS);
  assert.equal(saturday.balance, 13000);

  // Sunday 12:00 EAT: still nothing new
  const sunday = await balanceAt(6 * DAY_MS);
  assert.equal(sunday.balance, 13000);

  // Monday 12:00 EAT: the next business day is paid
  const monday = await balanceAt(7 * DAY_MS);
  assert.equal(monday.balance, 16000);

  const list = await call('/investments', { token: account.token });
  assert.equal(list.data.investments[0].daysPaid, 5);
});

/* --------------------------------- referrals --------------------------------- */

test('a 10% referral bonus is credited automatically on the first deposit', async () => {
  const inviter = await registerUser();

  const friend = nextUser();
  const joined = await call('/auth/register', {
    method: 'POST',
    body: { ...friend, inviteCode: inviter.user.referralCode },
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.data));
  assert.equal(joined.data.user.balance, 1000, 'the invitee keeps the welcome bonus');

  await mobileDeposit(joined.data.token, 50000);

  const me = await call('/me', { token: inviter.token });
  assert.equal(me.data.user.balance, 6000, '1,000 welcome + 5,000 referral');

  const invite = await call('/invite', { token: inviter.token });
  assert.equal(invite.data.totalInvited, 1);
  assert.equal(invite.data.totalEarned, 5000);
  assert.equal(invite.data.invited[0].name, friend.name);

  // A second deposit from the same friend pays no extra bonus
  await mobileDeposit(joined.data.token, 20000);
  const after = await call('/me', { token: inviter.token });
  assert.equal(after.data.user.balance, 6000);
});

/* ------------------------------- history, account ------------------------------- */

test('history only shows the member own transactions', async () => {
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

test('changing the password requires the current one', async () => {
  const account = await registerUser();

  const wrong = await call('/account/password', {
    method: 'POST',
    token: account.token,
    body: { currentPassword: 'wrong', newPassword: 'newpass123' },
  });
  assert.equal(wrong.status, 400);

  const changed = await call('/account/password', {
    method: 'POST',
    token: account.token,
    body: { currentPassword: account.password, newPassword: 'newpass123' },
  });
  assert.equal(changed.status, 200);

  const login = await call('/auth/login', {
    method: 'POST',
    body: { phone: account.phone, password: 'newpass123' },
  });
  assert.equal(login.status, 200);
});

test('the landing page is served in English', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Ship Transfer/);
  assert.match(html, /Sign in/);
  assert.match(html, /Create account/);
  assert.match(html, /Withdraw/);
});

/* ------------------------- mobile money deposits ------------------------- */

test('config shows the mobile money methods and the sandbox mode', async () => {
  const res = await call('/config');
  assert.equal(res.status, 200);
  assert.equal(res.data.payments.mode, 'sandbox');
  assert.equal(res.data.payments.live, false);
  assert.ok(res.data.payments.mobileMethods.includes('M-Pesa'));
  assert.ok(res.data.payments.mobileMethods.includes('Tigo Pesa'));
});

test('the charge payload sends the right network for each provider', () => {
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

  assert.throws(() =>
    payments.buildChargePayload({ amount: 5000, email: 'a@b.c', phone: '123', method: 'M-Pesa', txRef: 'tx-3' }),
  );
});

test('a mobile deposit completes once through the sandbox', async () => {
  const { token } = await registerUser();

  const res = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 25000, method: 'M-Pesa', phone: '0712345678' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.transaction.status, 'pending');
  assert.equal(res.data.transaction.channel, 'mobile_money');
  assert.equal(res.data.payment.mode, 'sandbox');

  const done = await call(`/deposit/${res.data.transaction.id}/simulate`, { method: 'POST', token });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.transaction.status, 'completed');
  assert.equal(done.data.user.capital, 25000);

  const again = await call(`/deposit/${res.data.transaction.id}/simulate`, { method: 'POST', token });
  assert.equal(again.status, 200);
  assert.equal(again.data.credited, false);
  assert.equal(again.data.user.capital, 25000);
});

test('a mobile deposit needs a valid phone number', async () => {
  const { token } = await registerUser();
  const res = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 25000, method: 'Tigo Pesa', phone: '123' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /phone/i);
});

test('a bank deposit stays manual and cannot be simulated', async () => {
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

test('the webhook needs a valid hash and credits a deposit once', async () => {
  const { token } = await registerUser();
  const created = await call('/deposit', {
    method: 'POST',
    token,
    body: { amount: 15000, method: 'M-Pesa', phone: '0712345678' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const txnId = created.data.transaction.id;

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
    assert.equal(after.data.user.capital, 15000);

    const dup = await hook('test-hash-123');
    assert.equal(dup.status, 200);
    const still = await call('/me', { token });
    assert.equal(still.data.user.capital, 15000);
  } finally {
    delete process.env.FLW_WEBHOOK_HASH;
  }
});

test('simulation is blocked once live keys are set', async () => {
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

/* --------------------------- automatic payouts --------------------------- */

test('the payout payload uses the right network and a local number', () => {
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

  const mpesa = payments.buildTransferPayload({
    amount: 9000,
    account: '0712345678',
    method: 'M-Pesa',
    reference: 'r2',
  });
  assert.equal(mpesa.account_bank, 'VODACOM');

  assert.throws(() =>
    payments.buildTransferPayload({ amount: 5000, account: '0712345678', method: 'Benki', reference: 'r3' }),
  );
  assert.throws(() =>
    payments.buildTransferPayload({ amount: 5000, account: '12', method: 'M-Pesa', reference: 'r4' }),
  );
  assert.throws(() =>
    payments.buildTransferPayload({ amount: 0, account: '0712345678', method: 'M-Pesa', reference: 'r5' }),
  );
});

test('a transfer webhook pays a withdrawal only once', async () => {
  process.env.FLW_WEBHOOK_HASH = 'test-hash';
  try {
    const member = await memberWithProfit(5, 5);
    const created = await call('/withdraw', {
      method: 'POST',
      token: member.token,
      body: { amount: 15000, method: 'M-Pesa', account: member.phone },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const state = db.getState();
    const txn = state.transactions.find((t) => t.id === created.data.transaction.id);
    domain.startPayout(state, txn, { provider: 'flutterwave', providerRef: 'FLW-T-1' });
    db.commit();

    const body = JSON.stringify({
      event: 'transfer.completed',
      data: { id: 'FLW-T-1', reference: txn.id, status: 'SUCCESSFUL', amount: 13500 },
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
    const owner = state.users.find((u) => u.id === member.user.id);
    assert.equal(owner.paidOut, 13500);
  } finally {
    delete process.env.FLW_WEBHOOK_HASH;
  }
});

test('a webhook without the right hash is refused', async () => {
  const response = await fetch(`${base}/api/payments/webhook/flutterwave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'verif-hash': 'wrong' },
    body: JSON.stringify({ event: 'transfer.completed', data: { reference: 'hack', status: 'SUCCESSFUL' } }),
  });
  assert.equal(response.status, 401);
});

test('a failed payout returns the request to the queue', async () => {
  const member = await memberWithProfit(5, 5);
  const created = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 12000, method: 'M-Pesa', account: member.phone },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const state = db.getState();
  const txn = state.transactions.find((t) => t.id === created.data.transaction.id);
  domain.startPayout(state, txn, { provider: 'flutterwave', providerRef: 'FLW-T-2' });
  domain.failPayout(state, txn, 'Provider balance is not enough');
  db.commit();

  const status = await call(`/withdraw/${txn.id}`, { token: member.token });
  assert.equal(status.status, 200);
  assert.equal(status.data.transaction.status, 'pending');
  assert.equal(status.data.transaction.payoutStatus, 'failed');
  assert.equal(status.data.transaction.failureReason, 'Provider balance is not enough');
});

test('a bank withdrawal stays manual for the admin', async () => {
  const admin = await adminToken();
  const member = await memberWithProfit(5, 5);

  const created = await call('/withdraw', {
    method: 'POST',
    token: member.token,
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
