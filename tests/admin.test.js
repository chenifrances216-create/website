'use strict';

/*
 * Admin panel tests: independent password, member segments, balance control,
 * password reveal/reset, withdrawal block, account deletion, deposit numbers
 * and deposit/withdrawal queues.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-admin-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = 'PanelTest1234';

const { createApp } = require('../src/app');
const domain = require('../src/domain');

let server;
let base;

// Monday 12:00 EAT — inside the withdrawal window
const MONDAY = Date.parse('2026-11-16T09:00:00.000Z');
const PANEL_PASSWORD = 'PanelTest1234';

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
  return { phone: `0765${String(200000 + counter).slice(-6)}`, password: 'secret1234' };
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

async function registerUser() {
  const user = nextUser();
  const res = await call('/auth/register', { method: 'POST', body: user });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { ...user, token: res.data.token, user: res.data.user };
}

async function panelLogin(password = PANEL_PASSWORD) {
  return call('/apanel/login', { method: 'POST', body: { password } });
}

async function panelToken() {
  const res = await panelLogin();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.token;
}

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

function findMember(overview, phone) {
  return overview.members.find((m) => m.phone === phone);
}

/* --------------------------- kuingia kwa admin --------------------------- */

test('the admin panel has its own password and ignores member sessions', async () => {
  const member = await registerUser();

  const wrong = await panelLogin('wrong-password');
  assert.equal(wrong.status, 401);

  const noToken = await call('/apanel/overview');
  assert.equal(noToken.status, 401);

  const memberToken = await call('/apanel/overview', { token: member.token });
  assert.equal(memberToken.status, 401, 'a member token must never open the panel');

  const ok = await panelLogin();
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.token);
  assert.equal(ok.data.usingDefault, false);

  const overview = await call('/apanel/overview', { token: ok.data.token });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.stats.members >= 1);
});

test('the panel admin password can be changed and old sessions stop working', async () => {
  const token = await panelToken();

  const weak = await call('/apanel/password', {
    method: 'POST',
    token,
    body: { current: PANEL_PASSWORD, next: 'short' },
  });
  assert.equal(weak.status, 400);

  const changed = await call('/apanel/password', {
    method: 'POST',
    token,
    body: { current: PANEL_PASSWORD, next: 'BrandNewPanel9' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));

  const stale = await call('/apanel/overview', { token });
  assert.equal(stale.status, 401, 'previous sessions are dropped after a password change');

  const relogin = await panelLogin('BrandNewPanel9');
  assert.equal(relogin.status, 200);
  // restore for the remaining tests
  await call('/apanel/password', {
    method: 'POST',
    token: relogin.data.token,
    body: { current: 'BrandNewPanel9', next: PANEL_PASSWORD },
  });
});

/* --------------------------- wanachama --------------------------- */

test('members are split into depositors and registered-only accounts', async () => {
  const token = await panelToken();
  const saver = await registerUser();
  const idle = await registerUser();
  await mobileDeposit(saver.token, 50000);

  const overview = await call('/apanel/overview', { token });
  assert.equal(overview.status, 200);

  const active = findMember(overview.data, saver.user.phone);
  const registered = findMember(overview.data, idle.user.phone);

  assert.equal(active.segment, 'active');
  assert.equal(active.totalDeposit, 50000);
  assert.equal(active.capital, 50000);

  assert.equal(registered.segment, 'registered');
  assert.equal(registered.totalDeposit, 0);

  assert.ok(overview.data.stats.depositors >= 1);
  assert.ok(overview.data.stats.registeredOnly >= 1);

  const onlyRegistered = await call('/apanel/members?segment=registered', { token });
  assert.equal(onlyRegistered.status, 200);
  assert.ok(onlyRegistered.data.members.every((m) => m.segment === 'registered'));
  assert.ok(onlyRegistered.data.members.some((m) => m.phone === idle.user.phone));
});

test('the admin can add and reduce a member balance', async () => {
  const token = await panelToken();
  const member = await registerUser();
  const start = member.user.balance; // welcome bonus

  const credit = await call(`/apanel/members/${member.user.id}/balance`, {
    method: 'POST',
    token,
    body: { action: 'credit', amount: 5000, note: 'Goodwill' },
  });
  assert.equal(credit.status, 200, JSON.stringify(credit.data));
  assert.equal(credit.data.member.balance, start + 5000);

  const debit = await call(`/apanel/members/${member.user.id}/balance`, {
    method: 'POST',
    token,
    body: { action: 'debit', amount: 2000 },
  });
  assert.equal(debit.status, 200, JSON.stringify(debit.data));
  assert.equal(debit.data.member.balance, start + 3000);

  const tooMuch = await call(`/apanel/members/${member.user.id}/balance`, {
    method: 'POST',
    token,
    body: { action: 'debit', amount: 999999 },
  });
  assert.equal(tooMuch.status, 400);

  const me = await call('/me', { token: member.token });
  assert.equal(me.data.user.balance, start + 3000, 'the member sees the adjusted balance');
});

test('member passwords can be revealed and reset from the panel', async () => {
  const token = await panelToken();
  const member = await registerUser();

  const revealed = await call(`/apanel/members/${member.user.id}/password`, { token });
  assert.equal(revealed.status, 200, JSON.stringify(revealed.data));
  assert.equal(revealed.data.password, member.password);

  const reset = await call(`/apanel/members/${member.user.id}/password`, {
    method: 'POST',
    token,
    body: { password: 'freshpass9' },
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));

  const oldLogin = await call('/auth/login', {
    method: 'POST',
    body: { phone: member.user.phone, password: member.password },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await call('/auth/login', {
    method: 'POST',
    body: { phone: member.user.phone, password: 'freshpass9' },
  });
  assert.equal(newLogin.status, 200, JSON.stringify(newLogin.data));

  const revealedAgain = await call(`/apanel/members/${member.user.id}/password`, { token });
  assert.equal(revealedAgain.data.password, 'freshpass9');
});

test('blocking withdrawals stops a member from requesting a payout', async () => {
  const token = await panelToken();
  const member = await registerUser();

  await call(`/apanel/members/${member.user.id}/balance`, {
    method: 'POST',
    token,
    body: { action: 'credit', amount: 10000 },
  });

  const blocked = await call(`/apanel/members/${member.user.id}/withdraw-block`, {
    method: 'POST',
    token,
    body: { blocked: true, reason: 'Verification pending' },
  });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.data));
  assert.equal(blocked.data.member.withdrawBlocked, true);

  const me = await call('/me', { token: member.token });
  assert.equal(me.data.user.withdrawBlocked, true);
  assert.equal(me.data.user.withdrawBlockReason, 'Verification pending');

  const attempt = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 3000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(attempt.status, 403, JSON.stringify(attempt.data));
  assert.match(attempt.data.error, /blocked/i);

  const unblocked = await call(`/apanel/members/${member.user.id}/withdraw-block`, {
    method: 'POST',
    token,
    body: { blocked: false },
  });
  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.data.member.withdrawBlocked, false);

  const allowed = await call('/withdraw', {
    method: 'POST',
    token: member.token,
    body: { amount: 3000, method: 'M-Pesa', account: '0712345678' },
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
});

test('the admin can delete a member account', async () => {
  const token = await panelToken();
  const member = await registerUser();

  const removed = await call(`/apanel/members/${member.user.id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  const overview = await call('/apanel/overview', { token });
  assert.equal(findMember(overview.data, member.user.phone), undefined);

  const login = await call('/auth/login', {
    method: 'POST',
    body: { phone: member.user.phone, password: member.password },
  });
  assert.equal(login.status, 401, 'the deleted account can no longer sign in');

  const missing = await call(`/apanel/members/${member.user.id}`, { method: 'DELETE', token });
  assert.equal(missing.status, 404);
});

/* --------------------------- namba za deposit --------------------------- */

test('deposit numbers added in the panel reach the member deposit screen', async () => {
  const token = await panelToken();

  const bad = await call('/apanel/deposit-numbers', {
    method: 'POST',
    token,
    body: { method: 'M-Pesa', number: 'abc', name: 'Ship Transfer' },
  });
  assert.equal(bad.status, 400);

  const saved = await call('/apanel/deposit-numbers', {
    method: 'POST',
    token,
    body: { method: 'M-Pesa', number: '0755 000 111', name: 'Ship Transfer Ltd', note: 'Use your phone number as reference' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const config = await call('/config');
  assert.equal(config.status, 200);
  const published = config.data.depositNumbers.find((n) => n.number === '0755 000 111');
  assert.ok(published, 'the number is published to members');
  assert.equal(published.name, 'Ship Transfer Ltd');

  const listed = await call('/apanel/deposit-numbers', { token });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.numbers.some((n) => n.id === published.id));

  const removed = await call(`/apanel/deposit-numbers/${published.id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);

  const after = await call('/config');
  assert.equal(after.data.depositNumbers.some((n) => n.number === '0755 000 111'), false);
});

/* --------------------------- deposit / withdraw --------------------------- */

test('pending deposits and withdrawals are listed and can be approved in the panel', async () => {
  const token = await panelToken();
  const member = await registerUser();

  const deposit = await call('/deposit', {
    method: 'POST',
    token: member.token,
    body: { amount: 50000, method: 'Benki', reference: 'CRDB-77' },
  });
  assert.equal(deposit.status, 201, JSON.stringify(deposit.data));

  const deposits = await call('/apanel/requests?type=deposit', { token });
  assert.equal(deposits.status, 200);
  const pending = deposits.data.requests.find((r) => r.id === deposit.data.transaction.id);
  assert.ok(pending, 'the deposit reaches the panel queue');
  assert.equal(pending.member.phone, member.user.phone);

  const approved = await call(`/apanel/requests/${pending.id}`, {
    method: 'POST',
    token,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));

  const me = await call('/me', { token: member.token });
  assert.equal(me.data.user.capital, 50000);

  const withdrawals = await call('/apanel/requests?type=withdraw', { token });
  assert.equal(withdrawals.status, 200);
  assert.equal(withdrawals.data.type, 'withdraw');
  assert.ok(Array.isArray(withdrawals.data.requests));

  const audit = await call('/apanel/overview', { token });
  assert.ok(audit.data.audit.some((entry) => entry.action === 'request_approve'));
});
