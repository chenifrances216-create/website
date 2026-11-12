'use strict';

const crypto = require('crypto');
const db = require('./db');
const {
  PACKAGES,
  MIN_DEPOSIT,
  MIN_WITHDRAW,
  MAX_AMOUNT,
  SIGNUP_BONUS,
  REFERRAL_RATE,
  WITHDRAW_FEE_RATE,
  WITHDRAW_OPEN_MINUTE,
  WITHDRAW_CLOSE_MINUTE,
  WITHDRAW_DAYS,
  TZ_OFFSET_MINUTES,
  TZ_LABEL,
  DAY_MS,
  INVEST_DAYS,
  DEPOSIT_METHODS,
  WITHDRAW_METHODS,
  TXN_LABELS,
} = require('./constants');
const { hashPassword, verifyPassword, destroyUserSessions } = require('./auth');
const payments = require('./payments');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nowIso() {
  return new Date().toISOString();
}

function money(amount) {
  return `TZS ${Number(amount || 0).toLocaleString('en-US')}`;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  let match = digits.match(/^255(\d{9})$/);
  if (match) return `+255${match[1]}`;
  match = digits.match(/^0(\d{9})$/);
  if (match) return `+255${match[1]}`;
  match = digits.match(/^(\d{9})$/);
  if (match) return `+255${match[1]}`;
  return null;
}

function assertAmount(value, label, min) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new ApiError(400, `${label} must be a whole number`);
  }
  if (amount < min) {
    throw new ApiError(400, `${label} must be at least ${money(min)}`);
  }
  if (amount > MAX_AMOUNT) {
    throw new ApiError(400, `${label} is above the limit of ${money(MAX_AMOUNT)}`);
  }
  return amount;
}

// ---------- Capital vs profit ----------
// user.capital = locked capital (deposits + returned capital), never withdrawable
// user.balance = withdrawable profit balance (daily profit + bonuses)
function capitalOf(user) {
  return Number(user && user.capital ? user.capital : 0);
}

function profitOf(user) {
  return Number(user && user.balance ? user.balance : 0);
}

// ---------- Business days (East Africa Time, UTC+3) ----------
function eatParts(ts) {
  const d = new Date(Number(ts) + TZ_OFFSET_MINUTES * 60 * 1000);
  return { weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function isBusinessDay(ts) {
  return WITHDRAW_DAYS.includes(eatParts(ts).weekday);
}

// Clock seam: tests inject a fixed time so the withdrawal window is deterministic.
let clock = () => Date.now();
function setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}
function nowOf() {
  return clock();
}

function withdrawalWindow(now = nowOf()) {
  const { weekday, minutes } = eatParts(now);
  const weekdayOpen = WITHDRAW_DAYS.includes(weekday);
  const timeOpen = minutes >= WITHDRAW_OPEN_MINUTE && minutes < WITHDRAW_CLOSE_MINUTE;
  let message = 'Withdrawals are open.';
  if (!weekdayOpen) message = 'Withdrawals are closed on Saturday and Sunday.';
  else if (minutes < WITHDRAW_OPEN_MINUTE) message = 'Withdrawals open at 10:00 EAT.';
  else if (minutes >= WITHDRAW_CLOSE_MINUTE) message = 'Withdrawals close at 17:00 EAT.';
  return {
    open: weekdayOpen && timeOpen,
    weekdayOpen,
    timeOpen,
    weekday,
    days: 'Monday - Friday',
    openAt: '10:00',
    closeAt: '17:00',
    timezone: TZ_LABEL,
    message,
  };
}

function withdrawFee(amount) {
  return Math.round(Number(amount || 0) * WITHDRAW_FEE_RATE);
}

function netOf(txn) {
  if (!txn) return 0;
  const meta = txn.meta || {};
  if (Number.isFinite(meta.net)) return Number(meta.net);
  return Math.max(0, txn.amount - withdrawFee(txn.amount));
}

function addTxn(state, { userId, type, amount, status = 'completed', method = null, note = null, meta = null }) {
  const txn = {
    id: db.newId(),
    userId,
    type,
    amount,
    status,
    method,
    note,
    meta: meta || null,
    createdAt: nowIso(),
  };
  state.transactions.push(txn);
  return txn;
}

function uniqueReferralCode(state) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let code = 'SHIP';
    for (let i = 0; i < 5; i += 1) {
      code += REFERRAL_ALPHABET[crypto.randomInt(REFERRAL_ALPHABET.length)];
    }
    if (!state.users.some((u) => u.referralCode === code)) return code;
  }
  return `SHIP${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

function packageById(id) {
  return PACKAGES.find((p) => p.id === String(id || '').toLowerCase()) || null;
}

function serializePackage(pkg) {
  return {
    id: pkg.id,
    name: pkg.name,
    level: pkg.level,
    shipName: pkg.shipName,
    image: pkg.image,
    tag: pkg.tag,
    capital: pkg.capital,
    min: pkg.min,
    max: pkg.max,
    dailyProfit: pkg.dailyProfit,
    dailyRate: pkg.dailyRate,
    days: pkg.days,
    perks: pkg.perks,
    monthlyProfit: pkg.dailyProfit * pkg.days,
  };
}

// Profit is credited 24h after renting, business days only (no Sat/Sun)
function eligibleProfitDays(inv, now) {
  const start = new Date(inv.startAt).getTime();
  const periods = Math.floor((now - start) / DAY_MS);
  const maxDays = inv.days || INVEST_DAYS;
  let counted = 0;
  for (let n = 1; n <= periods && counted < maxDays; n += 1) {
    if (isBusinessDay(start + n * DAY_MS)) counted += 1;
  }
  return counted;
}

function nextPayoutAt(inv) {
  if (!inv || inv.status !== 'active') return null;
  const start = new Date(inv.startAt).getTime();
  const now = nowOf();
  let n = Math.max(1, Math.floor((now - start) / DAY_MS) + 1);
  for (let i = 0; i < 20; i += 1) {
    const at = start + n * DAY_MS;
    if (isBusinessDay(at)) return new Date(at).toISOString();
    n += 1;
  }
  return null;
}

function accrue(state, user, now = nowOf()) {
  let changed = false;
  for (const inv of state.investments) {
    if (inv.userId !== user.id || inv.status !== 'active') continue;
    const target = Math.min(eligibleProfitDays(inv, now), inv.days || INVEST_DAYS);
    if (target > inv.daysPaid) {
      const newDays = target - inv.daysPaid;
      const profit = newDays * inv.dailyProfit;
      inv.daysPaid = target;
      inv.earned = (inv.earned || 0) + profit;
      inv.lastAccruedAt = new Date(now).toISOString();
      if (profit > 0) {
        user.balance = profitOf(user) + profit;
        addTxn(state, {
          userId: user.id,
          type: 'profit',
          amount: profit,
          note: `${inv.packageName} · ${inv.shipName} profit for ${newDays} business day${newDays === 1 ? '' : 's'}`,
          meta: { investmentId: inv.id },
        });
      }
      if (inv.daysPaid >= (inv.days || INVEST_DAYS)) {
        inv.status = 'completed';
        inv.completedAt = new Date(now).toISOString();
        user.capital = capitalOf(user) + inv.amount;
      }
      changed = true;
    }
  }
  return changed;
}

function publicUser(state, user) {
  const txns = state.transactions.filter((t) => t.userId === user.id);
  const completed = txns.filter((t) => t.status === 'completed');
  const sum = (type) => completed.filter((t) => t.type === type).reduce((acc, t) => acc + t.amount, 0);
  const active = state.investments.filter((i) => i.userId === user.id && i.status === 'active');
  const pending = txns.filter((t) => t.status === 'pending');
  const window = withdrawalWindow(nowOf());
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    vipLevel: user.vipLevel || 0,
    balance: profitOf(user),
    capital: capitalOf(user),
    withdrawable: profitOf(user),
    withdrawBlocked: Boolean(user.withdrawBlocked),
    withdrawBlockReason: user.withdrawBlockReason || null,
    lockedCapital: active.reduce((acc, i) => acc + i.amount, 0),
    referralCode: user.referralCode,
    createdAt: user.createdAt,
    totalDeposit: sum('deposit'),
    totalWithdraw: completed
      .filter((t) => t.type === 'withdraw')
      .reduce((acc, t) => acc + netOf(t), 0),
    totalProfit: sum('profit'),
    totalInvested: sum('invest'),
    totalBonus: sum('signup_bonus') + sum('invite_bonus'),
    activeInvestments: active.length,
    activeCapital: active.reduce((acc, i) => acc + i.amount, 0),
    pendingCount: pending.length,
    withdrawal: window,
  };
}

// 10% of the invited member's first deposit, credited automatically
function creditReferral(state, user, depositAmount) {
  if (!user.referredBy || user.referralPaid) return null;
  const referrer = state.users.find((u) => u.id === user.referredBy);
  if (!referrer) return null;
  const bonus = Math.round(Number(depositAmount || 0) * REFERRAL_RATE);
  if (bonus <= 0) return null;
  user.referralPaid = true;
  referrer.balance = profitOf(referrer) + bonus;
  addTxn(state, {
    userId: referrer.id,
    type: 'invite_bonus',
    amount: bonus,
    note: `${Math.round(REFERRAL_RATE * 100)}% referral bonus from ${user.name}'s first deposit`,
    meta: { invitedUserId: user.id, rate: REFERRAL_RATE, deposit: depositAmount },
  });
  return bonus;
}

function register(state, input) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ApiError(400, 'Enter a valid phone number (e.g. 0712 345 678)');

  const password = String(input.password || '');
  if (password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
  if (password.length > 100) throw new ApiError(400, 'Password is too long');

  if (state.users.some((u) => u.phone === phone)) {
    throw new ApiError(409, 'This phone number is already registered');
  }

  const typedName = String(input.name || '').trim();
  const name = typedName.length >= 2 && typedName.length <= 60 ? typedName : 'Member';

  let referrer = null;
  const code = String(input.inviteCode || '').trim().toUpperCase();
  if (code) {
    referrer = state.users.find((u) => u.referralCode === code) || null;
    if (!referrer) throw new ApiError(400, 'Invite code not found');
  }

  const user = {
    id: db.newId(),
    name,
    phone,
    passwordHash: hashPassword(password),
    referralCode: uniqueReferralCode(state),
    referredBy: referrer ? referrer.id : null,
    referralPaid: false,
    role: 'user',
    vipLevel: 0,
    balance: 0,
    capital: 0,
    createdAt: nowIso(),
  };
  state.users.push(user);

  user.balance = profitOf(user) + SIGNUP_BONUS;
  addTxn(state, {
    userId: user.id,
    type: 'signup_bonus',
    amount: SIGNUP_BONUS,
    note: 'Welcome bonus for joining Ship Transfer',
  });

  return user;
}

function login(state, input) {
  const identifier = String(input.phone || input.email || '').trim();
  if (!identifier) throw new ApiError(400, 'Enter your phone number');
  const phone = normalizePhone(identifier);
  const email = identifier.toLowerCase();
  const user = state.users.find(
    (u) => (phone && u.phone === phone) || (u.email && u.email === email)
  );
  const password = String(input.password || '');
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new ApiError(401, 'Incorrect phone number or password');
  }
  return user;
}

function changePassword(state, user, input) {
  if (!verifyPassword(String(input.currentPassword || ''), user.passwordHash)) {
    throw new ApiError(400, 'Current password is incorrect');
  }
  const next = String(input.newPassword || '');
  if (next.length < 6) throw new ApiError(400, 'New password must be at least 6 characters');
  user.passwordHash = hashPassword(next);
  destroyUserSessions(state, user.id);
  return user;
}

function createDeposit(state, user, input) {
  const amount = assertAmount(input.amount, 'Deposit amount', MIN_DEPOSIT);
  const method = String(input.method || '').trim();
  if (!DEPOSIT_METHODS.some((m) => m.id === method)) {
    throw new ApiError(400, 'Choose a valid payment method');
  }
  const reference = String(input.reference || '').trim().slice(0, 60);
  const mobile = payments.isMobileMethod(method);
  let phone = null;
  if (mobile) {
    phone = normalizePhone(input.phone || user.phone);
    if (!phone) throw new ApiError(400, 'Enter a valid phone number to pay with');
  }
  return addTxn(state, {
    userId: user.id,
    type: 'deposit',
    amount,
    status: 'pending',
    method,
    note: mobile ? `Deposit via ${method} (mobile money)` : `Deposit via ${method}`,
    meta: {
      reference,
      phone,
      network: mobile ? payments.networkFor(method) : null,
      channel: mobile ? 'mobile_money' : 'manual',
      provider: null,
      providerRef: null,
      paymentStatus: mobile ? 'initiated' : 'manual',
    },
  });
}

function attachPayment(txn, payment) {
  txn.meta = {
    ...(txn.meta || {}),
    provider: payment.provider || null,
    providerRef: payment.providerRef || null,
    paymentStatus: payment.status || 'pending',
    paymentMessage: payment.message || null,
    sandbox: Boolean(payment.sandbox),
    initiatedAt: nowIso(),
  };
  return txn;
}

function failDeposit(state, txn, reason) {
  if (!txn || txn.status !== 'pending') return txn;
  txn.status = 'failed';
  txn.decidedAt = nowIso();
  txn.meta = { ...(txn.meta || {}), error: String(reason || 'Payment failed').slice(0, 200) };
  return txn;
}

// Deposits fund locked capital; completes only once (idempotent)
function completeDeposit(state, txn, info = {}) {
  if (!txn) throw new ApiError(404, 'Deposit not found');
  if (txn.type !== 'deposit') throw new ApiError(400, 'This transaction is not a deposit');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'User not found');
  if (txn.status === 'completed') return { credited: false, txn, user };
  if (txn.status !== 'pending') throw new ApiError(400, 'This deposit cannot be confirmed');

  const paid = info.amount == null ? null : Number(info.amount);
  if (paid != null && Number.isFinite(paid) && paid !== txn.amount) {
    txn.meta = { ...(txn.meta || {}), amountMismatch: paid };
    throw new ApiError(409, 'The amount paid does not match the request. An admin will review it.');
  }
  if (info.currency && String(info.currency).toUpperCase() !== 'TZS') {
    throw new ApiError(400, 'Payment currency is not supported');
  }

  txn.status = 'completed';
  txn.decidedAt = nowIso();
  txn.meta = {
    ...(txn.meta || {}),
    providerRef: info.providerRef || (txn.meta && txn.meta.providerRef) || null,
    paymentStatus: 'completed',
    confirmedBy: info.source || 'provider',
    paidAmount: paid != null ? paid : txn.amount,
  };
  user.capital = capitalOf(user) + txn.amount;
  const referral = creditReferral(state, user, txn.amount);
  return { credited: true, txn, user, referral };
}

function findDeposit(state, userId, id) {
  return state.transactions.find((t) => t.id === id && t.userId === userId && t.type === 'deposit') || null;
}

function findDepositByRef(state, txRef) {
  return state.transactions.find((t) => t.id === txRef && t.type === 'deposit') || null;
}

// Withdrawals: profit only, min 3,000, 10% fee, Mon-Fri 10:00-17:00 EAT
function createWithdraw(state, user, input) {
  const amount = assertAmount(input.amount, 'Withdrawal amount', MIN_WITHDRAW);
  if (user.withdrawBlocked) {
    throw new ApiError(
      403,
      user.withdrawBlockReason
        ? `Withdrawals are blocked on this account: ${user.withdrawBlockReason}`
        : 'Withdrawals are blocked on this account. Please contact support.',
    );
  }

  const window = withdrawalWindow(nowOf());
  if (!window.open) {
    throw new ApiError(
      400,
      `${window.message} Withdrawals run Monday - Friday, 10:00 to 17:00 EAT.`,
    );
  }
  const method = String(input.method || '').trim();
  if (!WITHDRAW_METHODS.includes(method)) throw new ApiError(400, 'Choose a valid payout method');
  const account = String(input.account || '').trim();
  if (account.length < 5) throw new ApiError(400, 'Enter the phone number or account that will receive the money');

  const available = profitOf(user);
  if (available < amount) {
    throw new ApiError(
      400,
      `Profit balance is not enough. Available profit: ${money(available)}. Capital cannot be withdrawn.`,
    );
  }

  const fee = withdrawFee(amount);
  const net = amount - fee;
  user.balance = available - amount;
  return addTxn(state, {
    userId: user.id,
    type: 'withdraw',
    amount,
    status: 'pending',
    method,
    note: `Withdrawal via ${method}`,
    meta: {
      account: account.slice(0, 40),
      gross: amount,
      fee,
      net,
      feeRate: WITHDRAW_FEE_RATE,
      requestedAt: nowIso(),
    },
  });
}

function findWithdraw(state, userId, id) {
  return (
    state.transactions.find((t) => t.id === id && t.userId === userId && t.type === 'withdraw') || null
  );
}

function findWithdrawByRef(state, reference) {
  return state.transactions.find((t) => t.id === reference && t.type === 'withdraw') || null;
}

// Start the automatic payout (mobile money)
function startPayout(state, txn, info = {}) {
  if (!txn) throw new ApiError(404, 'Request not found');
  if (txn.type !== 'withdraw') throw new ApiError(400, 'This request is not a withdrawal');
  if (txn.status !== 'pending') throw new ApiError(400, 'This request has already been handled');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'User not found');
  txn.status = 'processing';
  txn.meta = {
    ...(txn.meta || {}),
    channel: 'mobile_money',
    payoutStatus: 'processing',
    provider: info.provider || payments.mode(),
    providerRef: info.providerRef || null,
    sandbox: Boolean(info.sandbox),
    payoutStartedAt: nowIso(),
    decidedBy: info.by || null,
  };
  return { txn, user };
}

// Pays the beneficiary once only, even if a webhook repeats
function completePayout(state, txn, info = {}) {
  if (!txn) throw new ApiError(404, 'Request not found');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'User not found');
  if (txn.status === 'completed') return { paid: false, txn, user };
  if (txn.status === 'rejected') throw new ApiError(400, 'This request was rejected');
  txn.status = 'completed';
  txn.decidedAt = nowIso();
  txn.meta = {
    ...(txn.meta || {}),
    payoutStatus: 'completed',
    providerRef: info.providerRef || (txn.meta && txn.meta.providerRef) || null,
    paidAt: nowIso(),
    paidBy: info.source || 'provider',
  };
  user.paidOut = (user.paidOut || 0) + netOf(txn);
  return { paid: true, txn, user };
}

// Payout failed: the request returns to the queue so the admin can retry
function failPayout(state, txn, reason) {
  if (!txn || txn.status !== 'processing') return txn;
  txn.status = 'pending';
  txn.meta = {
    ...(txn.meta || {}),
    payoutStatus: 'failed',
    error: String(reason || 'The payout did not go through').slice(0, 160),
  };
  return txn;
}

// Renting a ship uses locked capital only; the level requires its exact capital
function createInvestment(state, user, input) {
  const pkg = packageById(input.packageId);
  if (!pkg) throw new ApiError(400, 'That ship level does not exist');
  const amount = assertAmount(input.amount, 'Capital', pkg.capital);
  if (amount !== pkg.capital) {
    throw new ApiError(400, `${pkg.name} requires exactly ${money(pkg.capital)} of capital`);
  }
  const available = capitalOf(user);
  if (available < amount) {
    throw new ApiError(
      400,
      `Capital balance is not enough. Available capital: ${money(available)}. Profit cannot be used to rent a ship.`,
    );
  }

  user.capital = available - amount;
  const dailyProfit = pkg.dailyProfit;
  const investment = {
    id: db.newId(),
    userId: user.id,
    packageId: pkg.id,
    packageName: pkg.name,
    shipName: pkg.shipName,
    image: pkg.image,
    amount,
    dailyRate: pkg.dailyRate,
    dailyProfit,
    days: pkg.days,
    daysPaid: 0,
    earned: 0,
    startAt: nowIso(),
    status: 'active',
  };
  state.investments.push(investment);
  if (pkg.level > (user.vipLevel || 0)) user.vipLevel = pkg.level;

  addTxn(state, {
    userId: user.id,
    type: 'invest',
    amount,
    note: `Rented ${pkg.shipName} (${pkg.name}) · ${money(dailyProfit)} profit per business day`,
    meta: { investmentId: investment.id, packageId: pkg.id },
  });
  return investment;
}

function decideRequest(state, txnId, action, note) {
  const txn = state.transactions.find((t) => t.id === txnId);
  if (!txn) throw new ApiError(404, 'Request not found');
  if (txn.status !== 'pending') throw new ApiError(400, 'This request has already been handled');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'User not found');

  if (action === 'approve') {
    txn.status = 'completed';
    if (txn.type === 'deposit') {
      user.capital = capitalOf(user) + txn.amount;
      creditReferral(state, user, txn.amount);
    }
    if (txn.type === 'withdraw') user.paidOut = (user.paidOut || 0) + netOf(txn);
  } else if (action === 'reject') {
    txn.status = 'rejected';
    if (txn.type === 'withdraw') user.balance = profitOf(user) + txn.amount;
  } else {
    throw new ApiError(400, 'Invalid action');
  }
  txn.decidedAt = nowIso();
  txn.adminNote = note ? String(note).slice(0, 120) : null;
  return { txn, user };
}

function serializeTxn(txn) {
  const meta = txn.meta || {};
  return {
    id: txn.id,
    type: txn.type,
    label: TXN_LABELS[txn.type] || txn.type,
    amount: txn.amount,
    status: txn.status,
    method: txn.method,
    note: txn.note,
    reference: meta.reference ? meta.reference : null,
    channel: meta.channel || 'manual',
    phone: meta.phone || null,
    account: meta.account || null,
    fee: Number.isFinite(meta.fee) ? meta.fee : txn.type === 'withdraw' ? withdrawFee(txn.amount) : 0,
    net: txn.type === 'withdraw' ? netOf(txn) : txn.amount,
    provider: meta.provider || null,
    providerRef: meta.providerRef || null,
    paymentStatus: meta.paymentStatus || null,
    payoutStatus: meta.payoutStatus || null,
    sandbox: Boolean(meta.sandbox),
    failureReason: meta.error || null,
    adminNote: txn.adminNote || null,
    createdAt: txn.createdAt,
    decidedAt: txn.decidedAt || null,
  };
}

function serializeInvestment(inv) {
  const start = new Date(inv.startAt).getTime();
  const elapsed = Math.max(0, Math.floor((Date.now() - start) / DAY_MS));
  const days = inv.days || INVEST_DAYS;
  const daysPaid = inv.daysPaid || 0;
  return {
    id: inv.id,
    packageId: inv.packageId,
    packageName: inv.packageName,
    shipName: inv.shipName || inv.packageName,
    image: inv.image || null,
    amount: inv.amount,
    dailyProfit: inv.dailyProfit,
    days,
    daysPaid,
    daysElapsed: Math.min(elapsed, days),
    daysRemaining: Math.max(0, days - daysPaid),
    earned: inv.earned || 0,
    projectedTotal: inv.dailyProfit * days,
    startAt: inv.startAt,
    firstPayoutAt: new Date(start + DAY_MS).toISOString(),
    nextPayoutAt: nextPayoutAt(inv),
    status: inv.status,
    progress: Math.round((daysPaid / days) * 100),
  };
}

function inviteSummary(state, user) {
  const invited = state.users.filter((u) => u.referredBy === user.id);
  const earned = state.transactions
    .filter((t) => t.userId === user.id && t.type === 'invite_bonus' && t.status === 'completed')
    .reduce((acc, t) => acc + t.amount, 0);
  return {
    code: user.referralCode,
    totalInvited: invited.length,
    totalEarned: earned,
    bonusRate: REFERRAL_RATE,
    bonusPercent: Math.round(REFERRAL_RATE * 100),
    invited: invited
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((u) => ({ name: u.name, joinedAt: u.createdAt, vipLevel: u.vipLevel || 0, rewarded: Boolean(u.referralPaid) })),
  };
}

module.exports = {
  setClock,
  nowOf,
  ApiError,
  accrue,
  addTxn,
  attachPayment,
  capitalOf,
  changePassword,
  completeDeposit,
  completePayout,
  createDeposit,
  createInvestment,
  createWithdraw,
  creditReferral,
  decideRequest,
  eligibleProfitDays,
  failDeposit,
  failPayout,
  findDeposit,
  findDepositByRef,
  findWithdraw,
  findWithdrawByRef,
  inviteSummary,
  isBusinessDay,
  login,
  money,
  netOf,
  nextPayoutAt,
  normalizePhone,
  packageById,
  profitOf,
  publicUser,
  register,
  serializeInvestment,
  serializePackage,
  serializeTxn,
  startPayout,
  uniqueReferralCode,
  withdrawFee,
  withdrawalWindow,
};
