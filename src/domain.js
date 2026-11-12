'use strict';

const crypto = require('crypto');
const db = require('./db');
const {
  PACKAGES,
  MIN_DEPOSIT,
  MIN_WITHDRAW,
  MAX_AMOUNT,
  SIGNUP_BONUS,
  INVITE_BONUS_INVITER,
  INVITE_BONUS_INVITEE,
  DAY_MS,
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
    throw new ApiError(400, `${label} lazima iwe namba kamili`);
  }
  if (amount < min) {
    throw new ApiError(400, `${label} lazima iwe angalau ${money(min)}`);
  }
  if (amount > MAX_AMOUNT) {
    throw new ApiError(400, `${label} ni kubwa kuliko kikomo cha ${money(MAX_AMOUNT)}`);
  }
  return amount;
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
    ...pkg,
    dailyProfitAtMin: Math.round(pkg.min * pkg.dailyRate),
    totalProfitAtMin: Math.round(pkg.min * pkg.dailyRate) * pkg.days,
    totalReturnAtMin: pkg.min + Math.round(pkg.min * pkg.dailyRate) * pkg.days,
  };
}

function accrue(state, user, now = Date.now()) {
  let changed = false;
  for (const inv of state.investments) {
    if (inv.userId !== user.id || inv.status !== 'active') continue;
    const startAt = new Date(inv.startAt).getTime();
    const elapsedDays = Math.floor((now - startAt) / DAY_MS);
    const daysPaidTarget = Math.max(0, Math.min(elapsedDays, inv.days));
    if (daysPaidTarget > inv.daysPaid) {
      const newDays = daysPaidTarget - inv.daysPaid;
      const profit = newDays * inv.dailyProfit;
      inv.daysPaid = daysPaidTarget;
      inv.earned = (inv.earned || 0) + profit;
      inv.lastAccruedAt = new Date(now).toISOString();
      if (profit > 0) {
        user.balance += profit;
        addTxn(state, {
          userId: user.id,
          type: 'profit',
          amount: profit,
          note: `Faida ya ${inv.packageName} - siku ${newDays}`,
          meta: { investmentId: inv.id },
        });
      }
      if (inv.daysPaid >= inv.days) {
        inv.status = 'completed';
        inv.completedAt = new Date(now).toISOString();
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
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    vipLevel: user.vipLevel || 0,
    balance: user.balance,
    referralCode: user.referralCode,
    createdAt: user.createdAt,
    totalDeposit: sum('deposit'),
    totalWithdraw: sum('withdraw'),
    totalInvested: sum('invest'),
    totalProfit: sum('profit'),
    totalBonus: sum('signup_bonus') + sum('invite_bonus'),
    activeInvestments: active.length,
    activeCapital: active.reduce((acc, i) => acc + i.amount, 0),
    pendingCount: pending.length,
  };
}

function register(state, input) {
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 60) {
    throw new ApiError(400, 'Jina linahitajika (herufi 2 hadi 60)');
  }
  const email = String(input.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Barua pepe si sahihi');

  const phone = normalizePhone(input.phone);
  if (!phone) throw new ApiError(400, 'Namba ya simu si sahihi (mfano 0712 345 678)');

  const password = String(input.password || '');
  if (password.length < 6) throw new ApiError(400, 'Neno la siri linahitaji herufi 6 au zaidi');
  if (password.length > 100) throw new ApiError(400, 'Neno la siri ni refu mno');

  if (state.users.some((u) => u.email === email)) throw new ApiError(409, 'Barua pepe hii imetumika');
  if (state.users.some((u) => u.phone === phone)) throw new ApiError(409, 'Namba hii ya simu imetumika');

  let referrer = null;
  const code = String(input.inviteCode || '').trim().toUpperCase();
  if (code) {
    referrer = state.users.find((u) => u.referralCode === code) || null;
    if (!referrer) throw new ApiError(400, 'Kodi ya mwaliko haipo');
  }

  const user = {
    id: db.newId(),
    name,
    email,
    phone,
    passwordHash: hashPassword(password),
    referralCode: uniqueReferralCode(state),
    referredBy: referrer ? referrer.id : null,
    role: 'user',
    vipLevel: 0,
    balance: 0,
    createdAt: nowIso(),
  };
  state.users.push(user);

  user.balance += SIGNUP_BONUS;
  addTxn(state, {
    userId: user.id,
    type: 'signup_bonus',
    amount: SIGNUP_BONUS,
    note: 'Bonasi ya kukaribisha Ship Transfer',
  });

  if (referrer) {
    referrer.balance += INVITE_BONUS_INVITER;
    addTxn(state, {
      userId: referrer.id,
      type: 'invite_bonus',
      amount: INVITE_BONUS_INVITER,
      note: `Bonasi ya mwaliko: ${name}`,
      meta: { invitedUserId: user.id },
    });
    user.balance += INVITE_BONUS_INVITEE;
    addTxn(state, {
      userId: user.id,
      type: 'invite_bonus',
      amount: INVITE_BONUS_INVITEE,
      note: `Bonasi ya mwaliko kutoka kwa ${referrer.name}`,
      meta: { referrerId: referrer.id },
    });
  }

  return user;
}

function login(state, input) {
  const identifier = String(input.email || '').trim().toLowerCase();
  if (!identifier) throw new ApiError(400, 'Weka barua pepe au namba ya simu');
  const phone = normalizePhone(identifier);
  const user = state.users.find((u) => u.email === identifier || (phone && u.phone === phone));
  const password = String(input.password || '');
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new ApiError(401, 'Taarifa za kuingia si sahihi');
  }
  return user;
}

function changePassword(state, user, input) {
  if (!verifyPassword(String(input.currentPassword || ''), user.passwordHash)) {
    throw new ApiError(400, 'Neno la siri la sasa si sahihi');
  }
  const next = String(input.newPassword || '');
  if (next.length < 6) throw new ApiError(400, 'Neno la siri jipya linahitaji herufi 6 au zaidi');
  user.passwordHash = hashPassword(next);
  destroyUserSessions(state, user.id);
  return user;
}

function createDeposit(state, user, input) {
  const amount = assertAmount(input.amount, 'Kiasi cha amana', MIN_DEPOSIT);
  const method = String(input.method || '').trim();
  if (!DEPOSIT_METHODS.some((m) => m.id === method)) {
    throw new ApiError(400, 'Chagua njia ya malipo sahihi');
  }
  const reference = String(input.reference || '').trim().slice(0, 60);
  const mobile = payments.isMobileMethod(method);
  let phone = null;
  if (mobile) {
    phone = normalizePhone(input.phone || user.phone);
    if (!phone) throw new ApiError(400, 'Weka namba ya simu sahihi ya kulipia');
  }
  return addTxn(state, {
    userId: user.id,
    type: 'deposit',
    amount,
    status: 'pending',
    method,
    note: mobile ? `Amana kupitia ${method} (malipo ya simu)` : `Amana kupitia ${method}`,
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
  txn.meta = { ...(txn.meta || {}), error: String(reason || 'Malipo hayakufanikiwa').slice(0, 200) };
  return txn;
}

// Hukamilisha amana mara moja tu (idempotent) na kuongeza salio
function completeDeposit(state, txn, info = {}) {
  if (!txn) throw new ApiError(404, 'Amana haipo');
  if (txn.type !== 'deposit') throw new ApiError(400, 'Muamala huu si amana');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'Mtumiaji halipo');
  if (txn.status === 'completed') return { credited: false, txn, user };
  if (txn.status !== 'pending') throw new ApiError(400, 'Muamala huu hauwezi kuthibitishwa');

  const paid = info.amount == null ? null : Number(info.amount);
  if (paid != null && Number.isFinite(paid) && paid !== txn.amount) {
    txn.meta = { ...(txn.meta || {}), amountMismatch: paid };
    throw new ApiError(409, 'Kiasi kilicholipwa hakiendani na ombi. Msimamizi atahakiki.');
  }
  if (info.currency && String(info.currency).toUpperCase() !== 'TZS') {
    throw new ApiError(400, 'Sarafu ya malipo si sahihi');
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
  user.balance += txn.amount;
  return { credited: true, txn, user };
}

function findDeposit(state, userId, id) {
  return state.transactions.find((t) => t.id === id && t.userId === userId && t.type === 'deposit') || null;
}

function findDepositByRef(state, txRef) {
  return state.transactions.find((t) => t.id === txRef && t.type === 'deposit') || null;
}

function createWithdraw(state, user, input) {
  const amount = assertAmount(input.amount, 'Kiasi cha utoaji', MIN_WITHDRAW);
  const method = String(input.method || '').trim();
  if (!WITHDRAW_METHODS.includes(method)) throw new ApiError(400, 'Chagua njia ya kupokea pesa');
  const account = String(input.account || '').trim();
  if (account.length < 5) throw new ApiError(400, 'Weka namba ya simu au akaunti ya kupokea');
  if (user.balance < amount) throw new ApiError(400, `Salio halitoshi. Unayo ${money(user.balance)}`);
  user.balance -= amount;
  return addTxn(state, {
    userId: user.id,
    type: 'withdraw',
    amount,
    status: 'pending',
    method,
    note: `Utoaji kupitia ${method}`,
    meta: { account: account.slice(0, 40) },
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

// Anzisha utoaji wa kiotomatiki (payout) kwa mtandao wa simu
function startPayout(state, txn, info = {}) {
  if (!txn) throw new ApiError(404, 'Ombi halipo');
  if (txn.type !== 'withdraw') throw new ApiError(400, 'Ombi hili si la utoaji');
  if (txn.status !== 'pending') throw new ApiError(400, 'Ombi hili tayari limeshughulikiwa');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'Mtumiaji halipo');
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

// Kamilisha utoaji: hulipia mtu mara moja tu hata webhook irudi tena
function completePayout(state, txn, info = {}) {
  if (!txn) throw new ApiError(404, 'Ombi halipo');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'Mtumiaji halipo');
  if (txn.status === 'completed') return { paid: false, txn, user };
  if (txn.status === 'rejected') throw new ApiError(400, 'Ombi limekataliwa');
  txn.status = 'completed';
  txn.decidedAt = nowIso();
  txn.meta = {
    ...(txn.meta || {}),
    payoutStatus: 'completed',
    providerRef: info.providerRef || (txn.meta && txn.meta.providerRef) || null,
    paidAt: nowIso(),
    paidBy: info.source || 'provider',
  };
  user.paidOut = (user.paidOut || 0) + txn.amount;
  return { paid: true, txn, user };
}

// Utoaji umeshindikana: ombi linarudi kwenye foleni ili msimamizi ajaribu tena
function failPayout(state, txn, reason) {
  if (!txn || txn.status !== 'processing') return txn;
  txn.status = 'pending';
  txn.meta = {
    ...(txn.meta || {}),
    payoutStatus: 'failed',
    error: String(reason || 'Utoaji haukufanikiwa').slice(0, 160),
  };
  return txn;
}

function createInvestment(state, user, input) {
  const pkg = packageById(input.packageId);
  if (!pkg) throw new ApiError(400, 'Kifurushi cha VIP hakipo');
  const amount = assertAmount(input.amount, 'Kiasi cha uwekezaji', pkg.min);
  if (amount > pkg.max) {
    throw new ApiError(400, `${pkg.name} inakubali hadi ${money(pkg.max)}. Chagua kifurushi cha juu.`);
  }
  if (user.balance < amount) throw new ApiError(400, `Salio halitoshi. Unayo ${money(user.balance)}`);

  user.balance -= amount;
  const dailyProfit = Math.round(amount * pkg.dailyRate);
  const investment = {
    id: db.newId(),
    userId: user.id,
    packageId: pkg.id,
    packageName: pkg.name,
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
    note: `Uwekezaji ${pkg.name} - faida ${money(dailyProfit)} kwa siku`,
    meta: { investmentId: investment.id },
  });
  return investment;
}

function decideRequest(state, txnId, action, note) {
  const txn = state.transactions.find((t) => t.id === txnId);
  if (!txn) throw new ApiError(404, 'Ombi halipo');
  if (txn.status !== 'pending') throw new ApiError(400, 'Ombi hili tayari limeshughulikiwa');
  const user = state.users.find((u) => u.id === txn.userId);
  if (!user) throw new ApiError(404, 'Mtumiaji halipo');

  if (action === 'approve') {
    txn.status = 'completed';
    if (txn.type === 'deposit') user.balance += txn.amount;
    if (txn.type === 'withdraw') user.paidOut = (user.paidOut || 0) + txn.amount;
  } else if (action === 'reject') {
    txn.status = 'rejected';
    if (txn.type === 'withdraw') user.balance += txn.amount;
  } else {
    throw new ApiError(400, 'Kitendo si sahihi');
  }
  txn.decidedAt = nowIso();
  txn.adminNote = note ? String(note).slice(0, 120) : null;
  return { txn, user };
}

function serializeTxn(txn) {
  return {
    id: txn.id,
    type: txn.type,
    label: TXN_LABELS[txn.type] || txn.type,
    amount: txn.amount,
    status: txn.status,
    method: txn.method,
    note: txn.note,
    reference: txn.meta && txn.meta.reference ? txn.meta.reference : null,
    channel: (txn.meta && txn.meta.channel) || 'manual',
    phone: (txn.meta && txn.meta.phone) || null,
    provider: (txn.meta && txn.meta.provider) || null,
    providerRef: (txn.meta && txn.meta.providerRef) || null,
    paymentStatus: (txn.meta && txn.meta.paymentStatus) || null,
    payoutStatus: (txn.meta && txn.meta.payoutStatus) || null,
    sandbox: Boolean(txn.meta && txn.meta.sandbox),
    failureReason: (txn.meta && txn.meta.error) || null,
    adminNote: txn.adminNote || null,
    createdAt: txn.createdAt,
    decidedAt: txn.decidedAt || null,
  };
}

function serializeInvestment(inv) {
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(inv.startAt).getTime()) / DAY_MS));
  return {
    id: inv.id,
    packageId: inv.packageId,
    packageName: inv.packageName,
    amount: inv.amount,
    dailyProfit: inv.dailyProfit,
    days: inv.days,
    daysPaid: inv.daysPaid,
    daysElapsed: Math.min(elapsed, inv.days),
    earned: inv.earned || 0,
    projectedTotal: inv.dailyProfit * inv.days,
    startAt: inv.startAt,
    status: inv.status,
    progress: Math.round((inv.daysPaid / inv.days) * 100),
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
    bonusPerFriend: INVITE_BONUS_INVITER,
    invited: invited
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((u) => ({ name: u.name, joinedAt: u.createdAt, vipLevel: u.vipLevel || 0 })),
  };
}

module.exports = {
  ApiError,
  accrue,
  addTxn,
  attachPayment,
  changePassword,
  completeDeposit,
  completePayout,
  createDeposit,
  createWithdraw,
  decideRequest,
  failDeposit,
  failPayout,
  findDeposit,
  findDepositByRef,
  findWithdraw,
  findWithdrawByRef,
  startPayout,
  createInvestment,
  inviteSummary,
  login,
  money,
  normalizePhone,
  packageById,
  publicUser,
  register,
  serializeInvestment,
  serializePackage,
  serializeTxn,
  uniqueReferralCode,
};
