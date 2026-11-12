'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const domain = require('./domain');
const {
  PACKAGES,
  MIN_DEPOSIT,
  MIN_WITHDRAW,
  DEPOSIT_METHODS,
  WITHDRAW_METHODS,
  SIGNUP_BONUS,
  INVITE_BONUS_INVITER,
} = require('./constants');
const { createSession, getSession, destroySession, hashPassword } = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
}

function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function limiter(req, res, next) {
    const key = `${req.ip}|${req.path}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Majaribio mengi. Tafadhali subiri dakika chache.' });
    }
    return next();
  };
}

function seedAdmin(state) {
  if (state.users.some((u) => u.role === 'admin')) return;
  const email = String(process.env.ADMIN_EMAIL || 'admin@shiptransfer.co.tz').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || 'Ship@2026');
  state.users.push({
    id: db.newId(),
    name: 'Msimamizi',
    email,
    phone: '+255700000000',
    passwordHash: hashPassword(password),
    referralCode: 'SHIPADMIN',
    referredBy: null,
    role: 'admin',
    vipLevel: 5,
    balance: 0,
    createdAt: new Date().toISOString(),
  });
  db.commit();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));

  const state = db.getState();
  seedAdmin(state);

  const authLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });

  function requireAuth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const found = token ? getSession(state, token) : null;
    if (!found) return res.status(401).json({ error: 'Tafadhali ingia kwenye akaunti yako' });
    req.user = found.user;
    req.token = token;
    if (domain.accrue(state, req.user)) db.commit();
    return next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Ruhusa ya msimamizi inahitajika' });
    }
    return next();
  }

  // ---------- Umma ----------
  app.get('/api/config', (req, res) => {
    res.json({
      brand: 'Ship Transfer',
      currency: 'TZS',
      minDeposit: MIN_DEPOSIT,
      minWithdraw: MIN_WITHDRAW,
      signupBonus: SIGNUP_BONUS,
      inviteBonus: INVITE_BONUS_INVITER,
      depositMethods: DEPOSIT_METHODS,
      withdrawMethods: WITHDRAW_METHODS,
      packages: PACKAGES.map(domain.serializePackage),
    });
  });

  app.post('/api/auth/register', authLimiter, (req, res) => {
    const user = domain.register(state, req.body || {});
    const token = createSession(state, user.id);
    db.commit();
    res.status(201).json({
      token,
      user: domain.publicUser(state, user),
      packages: PACKAGES.map(domain.serializePackage),
    });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const user = domain.login(state, req.body || {});
    const token = createSession(state, user.id);
    db.commit();
    res.json({
      token,
      user: domain.publicUser(state, user),
      packages: PACKAGES.map(domain.serializePackage),
    });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    destroySession(state, req.token);
    db.commit();
    res.json({ ok: true });
  });

  // ---------- Mtumiaji aliyeingia ----------
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      user: domain.publicUser(state, req.user),
      packages: PACKAGES.map(domain.serializePackage),
    });
  });

  app.post('/api/deposit', requireAuth, (req, res) => {
    const txn = domain.createDeposit(state, req.user, req.body || {});
    db.commit();
    res.status(201).json({ transaction: domain.serializeTxn(txn), user: domain.publicUser(state, req.user) });
  });

  app.post('/api/withdraw', requireAuth, (req, res) => {
    const txn = domain.createWithdraw(state, req.user, req.body || {});
    db.commit();
    res.status(201).json({ transaction: domain.serializeTxn(txn), user: domain.publicUser(state, req.user) });
  });

  app.post('/api/invest', requireAuth, (req, res) => {
    const investment = domain.createInvestment(state, req.user, req.body || {});
    db.commit();
    res.status(201).json({
      investment: domain.serializeInvestment(investment),
      user: domain.publicUser(state, req.user),
    });
  });

  app.get('/api/transactions', requireAuth, (req, res) => {
    const type = String(req.query.type || '').trim();
    const list = state.transactions
      .filter((t) => t.userId === req.user.id)
      .filter((t) => !type || type === 'all' || t.type === type)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 200)
      .map(domain.serializeTxn);
    res.json({ transactions: list });
  });

  app.get('/api/investments', requireAuth, (req, res) => {
    const list = state.investments
      .filter((i) => i.userId === req.user.id)
      .sort((a, b) => new Date(b.startAt) - new Date(a.startAt))
      .map(domain.serializeInvestment);
    res.json({ investments: list });
  });

  app.get('/api/invite', requireAuth, (req, res) => {
    res.json(domain.inviteSummary(state, req.user));
  });

  app.post('/api/account/password', requireAuth, (req, res) => {
    domain.changePassword(state, req.user, req.body || {});
    destroySession(state, req.token);
    db.commit();
    res.json({ ok: true, message: 'Neno la siri limebadilishwa. Ingia tena.' });
  });

  // ---------- Msimamizi ----------
  app.get('/api/admin/overview', requireAuth, requireAdmin, (req, res) => {
    const pending = state.transactions
      .filter((t) => t.status === 'pending')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((t) => {
        const owner = state.users.find((u) => u.id === t.userId);
        return {
          ...domain.serializeTxn(t),
          user: owner
            ? { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone, balance: owner.balance }
            : null,
        };
      });
    const completed = state.transactions.filter((t) => t.status === 'completed');
    const sum = (type) => completed.filter((t) => t.type === type).reduce((acc, t) => acc + t.amount, 0);
    res.json({
      stats: {
        users: state.users.filter((u) => u.role !== 'admin').length,
        pendingDeposits: pending.filter((t) => t.type === 'deposit').length,
        pendingWithdrawals: pending.filter((t) => t.type === 'withdraw').length,
        totalDeposited: sum('deposit'),
        totalWithdrawn: sum('withdraw'),
        totalInvested: sum('invest'),
      },
      requests: pending,
      recentUsers: state.users
        .filter((u) => u.role !== 'admin')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          phone: u.phone,
          balance: u.balance,
          vipLevel: u.vipLevel || 0,
          createdAt: u.createdAt,
        })),
    });
  });

  app.post('/api/admin/transactions/:id/decision', requireAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const result = domain.decideRequest(state, req.params.id, String(body.action || ''), body.note);
    db.commit();
    res.json({
      transaction: domain.serializeTxn(result.txn),
      user: domain.publicUser(state, result.user),
    });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Njia hii ya API haipo' });
  });

  // ---------- Tovuti ----------
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h', index: 'index.html' }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (path.extname(req.path)) return next();
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Haipo' });
  });

  app.use((err, req, res, next) => {
    if (err instanceof domain.ApiError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      return res.status(400).json({ error: 'Data iliyotumwa si sahihi' });
    }
    console.error('[api]', err);
    return res.status(500).json({ error: 'Hitilafu ya mfumo. Tafadhali jaribu tena.' });
  });

  return app;
}

module.exports = { createApp };
