'use strict';

/*
 * Independent admin panel for Ship Transfer.
 *
 * - Its own password (ADMIN_PASSWORD env, or a default that the panel tells
 *   the admin to change) and its own session store, completely separate from
 *   member sessions. Nothing here is reachable with a member token.
 * - Members never see this page: it lives at /admin and is not linked from
 *   the member app.
 */

const crypto = require('crypto');
const db = require('./db');
const domain = require('./domain');
const seal = require('./seal');
const { hashPassword, verifyPassword, destroyUserSessions } = require('./auth');

const SESSION_MS = 8 * 60 * 60 * 1000;
const DEFAULT_PASSWORD = 'Admin@2026';
const MAX_AUDIT = 300;
const MAX_REQUESTS = 300;

class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function fail(status, message) {
  throw new AdminError(status, message);
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function envPassword() {
  return String(process.env.ADMIN_PASSWORD || '').trim();
}

function panel(state) {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!state.meta.adminPanel) {
    state.meta.adminPanel = {
      passwordHash: hashPassword(envPassword() || DEFAULT_PASSWORD),
      usingDefault: !envPassword(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }
  return state.meta.adminPanel;
}

function sessions(state) {
  if (!Array.isArray(state.adminSessions)) state.adminSessions = [];
  return state.adminSessions;
}

function audit(state, action, detail) {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!Array.isArray(state.meta.adminLog)) state.meta.adminLog = [];
  state.meta.adminLog.unshift({ id: db.newId(), at: nowIso(), action, detail: detail || null });
  if (state.meta.adminLog.length > MAX_AUDIT) state.meta.adminLog.length = MAX_AUDIT;
}

// ---------- Kuingia (admin pekee) ----------

function login(state, password) {
  const record = panel(state);
  const typed = String(password || '');
  if (!typed) fail(400, 'Enter the admin password');
  if (!verifyPassword(typed, record.passwordHash)) fail(401, 'Wrong admin password');

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  state.adminSessions = sessions(state).filter((s) => new Date(s.expiresAt).getTime() > now);
  state.adminSessions.push({
    id: db.newId(),
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_MS).toISOString(),
  });
  audit(state, 'admin_login', 'Admin signed in');
  db.commit();
  return {
    token,
    expiresAt: new Date(now + SESSION_MS).toISOString(),
    usingDefault: Boolean(record.usingDefault),
  };
}

function requireSession(state, token) {
  const raw = String(token || '');
  if (!raw) fail(401, 'Admin sign-in required');
  const digest = hashToken(raw);
  const found = sessions(state).find((s) => s.tokenHash === digest);
  if (!found) fail(401, 'Admin sign-in required');
  if (new Date(found.expiresAt).getTime() <= Date.now()) {
    state.adminSessions = sessions(state).filter((s) => s.tokenHash !== digest);
    db.commit();
    fail(401, 'Admin session expired. Sign in again.');
  }
  return found;
}

function logout(state, token) {
  const digest = hashToken(String(token || ''));
  state.adminSessions = sessions(state).filter((s) => s.tokenHash !== digest);
  db.commit();
  return { ok: true };
}

function changePassword(state, input) {
  const record = panel(state);
  if (!verifyPassword(String(input.current || ''), record.passwordHash)) {
    fail(401, 'Current admin password is wrong');
  }
  const next = String(input.next || '');
  if (next.length < 8) fail(400, 'New admin password must be at least 8 characters');
  if (next.length > 100) fail(400, 'New admin password is too long');
  record.passwordHash = hashPassword(next);
  record.usingDefault = false;
  record.updatedAt = nowIso();
  state.adminSessions = [];
  audit(state, 'admin_password_changed', 'Admin password changed');
  db.commit();
  return { ok: true };
}

// ---------- Wanachama ----------

function totalsFor(state, userId) {
  const txns = state.transactions.filter((t) => t.userId === userId);
  const done = txns.filter((t) => t.status === 'completed');
  const sum = (type) => done.filter((t) => t.type === type).reduce((acc, t) => acc + t.amount, 0);
  const withdrawn = done
    .filter((t) => t.type === 'withdraw')
    .reduce((acc, t) => acc + (Number.isFinite(t.meta && t.meta.net) ? t.meta.net : t.amount), 0);
  return {
    deposit: sum('deposit'),
    invest: sum('invest'),
    withdrawn,
    pending: txns.filter((t) => t.status === 'pending').length,
    lastAt: txns.reduce((acc, t) => (t.createdAt > acc ? t.createdAt : acc), '') || null,
  };
}

function memberRow(state, user) {
  const view = domain.publicUser(state, user);
  const totals = totalsFor(state, user.id);
  const investments = state.investments.filter((i) => i.userId === user.id);
  const activeInvestments = investments.filter((i) => i.status === 'active').length;
  const hasDeposit = totals.deposit > 0 || view.capital > 0 || (user.paidOut || 0) > 0;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    createdAt: user.createdAt,
    balance: view.balance,
    capital: view.capital,
    totalDeposit: totals.deposit,
    totalWithdraw: totals.withdrawn,
    totalInvested: totals.invest,
    activeInvestments,
    pendingCount: totals.pending,
    lastActivityAt: totals.lastAt,
    withdrawBlocked: Boolean(user.withdrawBlocked),
    withdrawBlockReason: user.withdrawBlockReason || null,
    passwordAvailable: Boolean(user.passwordSeal),
    hasDeposit,
    hasInvestment: investments.length > 0,
    segment: hasDeposit || investments.length > 0 ? 'active' : 'registered',
  };
}

function members(state) {
  let changed = false;
  for (const user of state.users) {
    if (user.role === 'admin') continue;
    if (domain.accrue(state, user)) changed = true;
  }
  if (changed) db.commit();
  return state.users
    .filter((u) => u.role !== 'admin')
    .map((u) => memberRow(state, u))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function findMember(state, id) {
  const user = state.users.find((u) => u.id === String(id || '') && u.role !== 'admin');
  if (!user) fail(404, 'Member not found');
  return user;
}

function revealPassword(state, id) {
  const user = findMember(state, id);
  const plain = seal.unseal(user.passwordSeal);
  if (!plain) {
    fail(409, 'This member has no stored password. Use "Set new password" for this account.');
  }
  audit(state, 'password_revealed', `Password revealed for ${user.phone}`);
  db.commit();
  return { phone: user.phone, password: plain };
}

function setPassword(state, id, input) {
  const user = findMember(state, id);
  const next = String(input.password || '');
  if (next.length < 6) fail(400, 'Password must be at least 6 characters');
  if (next.length > 100) fail(400, 'Password is too long');
  user.passwordHash = hashPassword(next);
  user.passwordSeal = seal.seal(next);
  destroyUserSessions(state, user.id);
  audit(state, 'member_password_set', `New password set for ${user.phone}`);
  db.commit();
  return { ok: true, password: next, member: memberRow(state, user) };
}

function adjustBalance(state, id, input) {
  const user = findMember(state, id);
  const action = String(input.action || '').toLowerCase();
  if (action !== 'credit' && action !== 'debit') fail(400, 'Choose credit or debit');
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) fail(400, 'Enter an amount greater than 0');
  if (amount > 100000000) fail(400, 'Amount is too large');

  const current = domain.publicUser(state, user).balance;
  if (action === 'debit' && amount > current) {
    fail(400, `Balance is only TZS ${current.toLocaleString('en-US')}`);
  }

  user.balance = action === 'credit' ? current + amount : current - amount;
  const note = String(input.note || '').trim().slice(0, 120);
  domain.addTxn(state, {
    userId: user.id,
    type: action === 'credit' ? 'admin_credit' : 'admin_debit',
    amount,
    note: note || (action === 'credit' ? 'Balance added by admin' : 'Balance reduced by admin'),
    meta: { channel: 'admin' },
  });
  audit(state, action === 'credit' ? 'balance_credit' : 'balance_debit', `${user.phone}: TZS ${amount}`);
  db.commit();
  return { member: memberRow(state, user) };
}

function setWithdrawBlocked(state, id, input) {
  const user = findMember(state, id);
  const blocked = Boolean(input.blocked);
  user.withdrawBlocked = blocked;
  user.withdrawBlockReason = blocked
    ? String(input.reason || 'Withdrawals are blocked by the administrator').slice(0, 120)
    : null;
  audit(state, blocked ? 'withdraw_blocked' : 'withdraw_unblocked', user.phone);
  db.commit();
  return { member: memberRow(state, user) };
}

function deleteMember(state, id) {
  const user = findMember(state, id);
  const phone = user.phone;
  state.users = state.users.filter((u) => u.id !== user.id);
  state.sessions = state.sessions.filter((s) => s.userId !== user.id);
  state.transactions = state.transactions.filter((t) => t.userId !== user.id);
  state.investments = state.investments.filter((i) => i.userId !== user.id);
  for (const other of state.users) {
    if (other.referredBy === user.id) other.referredBy = null;
  }
  audit(state, 'member_deleted', `Account ${phone} deleted`);
  db.commit();
  return { ok: true, phone };
}

// ---------- Namba za deposit ----------

function depositNumbers(state) {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!Array.isArray(state.meta.depositNumbers)) state.meta.depositNumbers = [];
  return state.meta.depositNumbers;
}

function publicDepositNumbers(state) {
  return depositNumbers(state)
    .filter((n) => n.active !== false)
    .map((n) => ({ id: n.id, method: n.method, number: n.number, name: n.name, note: n.note || null }));
}

function saveDepositNumber(state, input) {
  const method = String(input.method || '').trim();
  const number = String(input.number || '').trim();
  const name = String(input.name || '').trim();
  if (method.length < 2) fail(400, 'Choose the payment network');
  if (!/^[0-9+ ]{7,20}$/.test(number)) fail(400, 'Enter a valid deposit phone number');
  if (name.length < 2) fail(400, 'Enter the name registered on that number');

  const list = depositNumbers(state);
  const id = String(input.id || '').trim();
  const existing = id ? list.find((n) => n.id === id) : null;
  const note = String(input.note || '').trim().slice(0, 120) || null;

  if (existing) {
    existing.method = method;
    existing.number = number;
    existing.name = name;
    existing.note = note;
    if (input.active !== undefined) existing.active = Boolean(input.active);
    existing.updatedAt = nowIso();
  } else {
    list.push({
      id: db.newId(),
      method,
      number,
      name,
      note,
      active: input.active === undefined ? true : Boolean(input.active),
      createdAt: nowIso(),
    });
  }
  audit(state, 'deposit_number_saved', `${method} ${number}`);
  db.commit();
  return { depositNumbers: depositNumbers(state) };
}

function deleteDepositNumber(state, id) {
  const list = depositNumbers(state);
  const found = list.find((n) => n.id === String(id || ''));
  if (!found) fail(404, 'Deposit number not found');
  state.meta.depositNumbers = list.filter((n) => n.id !== found.id);
  audit(state, 'deposit_number_deleted', `${found.method} ${found.number}`);
  db.commit();
  return { depositNumbers: state.meta.depositNumbers };
}

// ---------- Deposit / withdraw ----------

function requests(state, kind) {
  const type = String(kind || 'deposit') === 'withdraw' ? 'withdraw' : 'deposit';
  const rows = state.transactions
    .filter((t) => t.type === type)
    .map((txn) => {
      const user = state.users.find((u) => u.id === txn.userId);
      return {
        ...domain.serializeTxn(txn),
        member: user ? { id: user.id, name: user.name, phone: user.phone } : null,
        memberMissing: !user,
      };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return {
    type,
    total: rows.length,
    pending: rows.filter((r) => r.status === 'pending').length,
    requests: rows.slice(0, MAX_REQUESTS),
  };
}

function decide(state, txnId, input) {
  const action = String(input.action || '').toLowerCase();
  if (action !== 'approve' && action !== 'reject') fail(400, 'Choose approve or reject');
  const result = domain.decideRequest(state, String(txnId || ''), action, input.note);
  audit(
    state,
    `request_${action}`,
    `${result.txn.type} TZS ${result.txn.amount} for ${result.user.phone}`,
  );
  db.commit();
  return {
    transaction: domain.serializeTxn(result.txn),
    member: memberRow(state, result.user),
  };
}

// ---------- Muhtasari ----------

function overview(state) {
  const rows = members(state);
  const sum = (key) => rows.reduce((acc, row) => acc + row[key], 0);
  const pendingOf = (type) =>
    state.transactions.filter((t) => t.type === type && t.status === 'pending').length;
  return {
    stats: {
      members: rows.length,
      depositors: rows.filter((r) => r.segment === 'active').length,
      registeredOnly: rows.filter((r) => r.segment === 'registered').length,
      pendingDeposits: pendingOf('deposit'),
      pendingWithdrawals: pendingOf('withdraw'),
      totalBalance: sum('balance'),
      totalCapital: sum('capital'),
      totalDeposit: sum('totalDeposit'),
      totalWithdrawn: sum('totalWithdraw'),
      blocked: rows.filter((r) => r.withdrawBlocked).length,
    },
    members: rows,
    depositNumbers: depositNumbers(state),
    audit: (state.meta.adminLog || []).slice(0, 40),
    usingDefault: Boolean(panel(state).usingDefault),
  };
}

module.exports = {
  AdminError,
  login,
  logout,
  requireSession,
  changePassword,
  overview,
  members,
  findMember,
  memberRow,
  revealPassword,
  setPassword,
  adjustBalance,
  setWithdrawBlocked,
  deleteMember,
  depositNumbers,
  publicDepositNumbers,
  saveDepositNumber,
  deleteDepositNumber,
  requests,
  decide,
};
