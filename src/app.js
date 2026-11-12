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
  WITHDRAW_OPTIONS,
  SIGNUP_BONUS,
  RULES,
  REFERRAL_RATE,
} = require('./constants');
const { createSession, getSession, destroySession, hashPassword } = require('./auth');
const payments = require('./payments');
const adminpanel = require('./adminpanel');

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
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
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
    name: 'Administrator',
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

  const state = db.getState();
  seedAdmin(state);

  // Webhook ya mtoa huduma: inahitaji body ghafi kabla ya express.json
  app.post('/api/payments/webhook/flutterwave', express.raw({ type: '*/*', limit: '128kb' }), (req, res) => {
    if (!payments.verifyWebhook(req.get('verif-hash'))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    let payload = null;
    try {
      payload = JSON.parse(req.body && req.body.length ? req.body.toString('utf8') : '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }
    const data = (payload && payload.data) || {};
    const status = String(data.status || '').toLowerCase();

    // Amana (charge) au utoaji (transfer)
    const deposit = domain.findDepositByRef(state, String(data.tx_ref || ''));
    if (deposit) {
      if (status !== 'successful') {
        if (status === 'failed') {
          domain.failDeposit(state, deposit, data.processor_response || 'Payment failed');
          db.commit();
        }
        return res.json({ ok: true, ignored: true });
      }
      try {
        domain.completeDeposit(state, deposit, {
          providerRef: String(data.id || ''),
          amount: data.amount != null ? Number(data.amount) : null,
          currency: data.currency,
          source: 'webhook',
        });
        db.commit();
        return res.json({ ok: true });
      } catch (err) {
        db.commit();
        return res.status(err.status || 500).json({ error: err.message });
      }
    }

    const withdrawal = domain.findWithdrawByRef(state, String(data.reference || data.tx_ref || ''));
    if (!withdrawal) return res.status(404).json({ error: 'Transaction not found' });

    if (['successful', 'completed'].includes(status)) {
      try {
        domain.completePayout(state, withdrawal, {
          providerRef: String(data.id || ''),
          source: 'webhook',
        });
        db.commit();
        return res.json({ ok: true });
      } catch (err) {
        db.commit();
        return res.status(err.status || 500).json({ error: err.message });
      }
    }
    if (status === 'failed') {
      domain.failPayout(state, withdrawal, data.complete_message || 'Payout failed');
      db.commit();
    }
    return res.json({ ok: true, ignored: true });
  });

  app.use(express.json({ limit: '64kb' }));

  const authLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });

  function requireAuth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const found = token ? getSession(state, token) : null;
    if (!found) return res.status(401).json({ error: 'Please sign in to your account' });
    req.user = found.user;
    req.token = token;
    if (domain.accrue(state, req.user)) db.commit();
    return next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator permission required' });
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
      referralRate: REFERRAL_RATE,
      depositMethods: DEPOSIT_METHODS,
      withdrawMethods: WITHDRAW_METHODS,
      withdrawOptions: WITHDRAW_OPTIONS,
      rules: RULES,
      withdrawal: domain.withdrawalWindow(),
      payments: payments.describe(),
      depositNumbers: adminpanel.publicDepositNumbers(state),
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

  app.post('/api/deposit', requireAuth, async (req, res) => {
    let txn = null;
    try {
      txn = domain.createDeposit(state, req.user, req.body || {});
      db.commit();

      if (!payments.isMobileMethod(txn.method)) {
        return res.status(201).json({
          transaction: domain.serializeTxn(txn),
          user: domain.publicUser(state, req.user),
          payment: {
            mode: payments.mode(),
            status: 'manual',
            message: 'Your deposit is waiting for admin approval.',
          },
        });
      }

      const charge = await payments.initiateCharge({
        amount: txn.amount,
        currency: 'TZS',
        email: req.user.email,
        phone: txn.meta.phone,
        method: txn.method,
        txRef: txn.id,
        name: req.user.name,
      });
      domain.attachPayment(txn, charge);
      db.commit();

      return res.status(201).json({
        transaction: domain.serializeTxn(txn),
        user: domain.publicUser(state, req.user),
        payment: {
          mode: payments.mode(),
          provider: charge.provider,
          providerRef: charge.providerRef,
          status: charge.status,
          message: charge.message,
          sandbox: Boolean(charge.sandbox),
        },
      });
    } catch (err) {
      if (txn && txn.status === 'pending') domain.failDeposit(state, txn, err.message);
      db.commit();
      if (err instanceof domain.ApiError) return res.status(err.status).json({ error: err.message });
      if (err instanceof payments.PaymentError) {
        return res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
      }
      console.error('[deposit]', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // Hali ya amana: hukagua mtoa huduma na kukamilisha ikiwa imelipwa
  app.get('/api/deposit/:id', requireAuth, async (req, res) => {
    const txn = domain.findDeposit(state, req.user.id, req.params.id);
    if (!txn) return res.status(404).json({ error: 'Deposit not found' });
    const meta = txn.meta || {};

    if (txn.status === 'pending' && meta.channel === 'mobile_money' && meta.providerRef && payments.isLive()) {
      const remote = await payments.fetchCharge(meta.providerRef).catch(() => null);
      if (remote && remote.status === 'successful') {
        try {
          domain.completeDeposit(state, txn, {
            providerRef: meta.providerRef,
            amount: Number.isFinite(remote.amount) ? remote.amount : null,
            currency: remote.currency,
            source: 'verify',
          });
        } catch (err) {
          txn.meta = { ...(txn.meta || {}), verifyError: err.message };
        }
        db.commit();
      } else if (remote && remote.status === 'failed') {
        domain.failDeposit(state, txn, 'Payment failed');
        db.commit();
      }
    }

    res.json({
      transaction: domain.serializeTxn(txn),
      user: domain.publicUser(state, req.user),
      payment: { mode: payments.mode(), status: txn.status },
    });
  });

  // Uigaji wa malipo: hupatikana tu pale hakuna funguo halisi
  app.post('/api/deposit/:id/simulate', requireAuth, (req, res) => {
    if (payments.isLive()) {
      return res.status(403).json({ error: 'Payment simulation is disabled while live payments are on' });
    }
    const txn = domain.findDeposit(state, req.user.id, req.params.id);
    if (!txn) return res.status(404).json({ error: 'Deposit not found' });
    if (txn.meta && txn.meta.channel !== 'mobile_money') {
      return res.status(400).json({ error: 'This is a bank deposit; an admin approves it' });
    }
    try {
      const result = domain.completeDeposit(state, txn, { source: 'sandbox' });
      db.commit();
      return res.json({
        credited: result.credited,
        transaction: domain.serializeTxn(txn),
        user: domain.publicUser(state, req.user),
        payment: { mode: payments.mode(), status: txn.status },
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/withdraw', requireAuth, (req, res) => {
    const txn = domain.createWithdraw(state, req.user, req.body || {});
    db.commit();
    res.status(201).json({
      transaction: domain.serializeTxn(txn),
      user: domain.publicUser(state, req.user),
      payout: {
        mode: payments.mode(),
        automatic: payments.isMobileMethod(txn.method),
        fee: txn.meta.fee,
        net: txn.meta.net,
        window: domain.withdrawalWindow(),
        message: payments.isMobileMethod(txn.method)
          ? 'Once an admin approves, the money is sent straight to your phone.'
          : 'Your request is waiting for admin approval.',
      },
    });
  });

  // Hali ya utoaji: hukagua mtoa huduma na kukamilisha ikiwa imetumwa
  app.get('/api/withdraw/:id', requireAuth, async (req, res) => {
    const txn = domain.findWithdraw(state, req.user.id, req.params.id);
    if (!txn) return res.status(404).json({ error: 'Withdrawal request not found' });
    const meta = txn.meta || {};

    if (txn.status === 'processing' && meta.providerRef && payments.isLive()) {
      const remote = await payments.fetchTransfer(meta.providerRef).catch(() => null);
      if (remote && ['successful', 'completed'].includes(String(remote.status).toLowerCase())) {
        domain.completePayout(state, txn, { providerRef: meta.providerRef, source: 'verify' });
        db.commit();
      } else if (remote && String(remote.status).toLowerCase() === 'failed') {
        domain.failPayout(state, txn, 'Payout failed');
        db.commit();
      }
    }

    res.json({
      transaction: domain.serializeTxn(txn),
      user: domain.publicUser(state, req.user),
      payment: { mode: payments.mode(), status: txn.status },
    });
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
    res.json({ ok: true, message: 'Password changed. Please sign in again.' });
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
        processingWithdrawals: state.transactions.filter((t) => t.type === 'withdraw' && t.status === 'processing').length,
        totalDeposited: sum('deposit'),
        totalWithdrawn: sum('withdraw'),
        totalInvested: sum('invest'),
      },
      requests: pending,
      payouts: state.transactions
        .filter((t) => t.type === 'withdraw' && t.status === 'processing')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 20)
        .map((t) => {
          const owner = state.users.find((u) => u.id === t.userId);
          return {
            ...domain.serializeTxn(t),
            user: owner ? { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone } : null,
          };
        }),
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

  app.post('/api/admin/transactions/:id/decision', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body || {};
    const action = String(body.action || '');
    const txn = state.transactions.find((t) => t.id === req.params.id);
    if (!txn) return res.status(404).json({ error: 'Request not found' });

    // Utoaji wa simu: hulipwa kiotomatiki kupitia mtoa huduma
    if (action === 'approve' && txn.type === 'withdraw' && payments.isMobileMethod(txn.method)) {
      let started = false;
      try {
        const { user } = domain.startPayout(state, txn, { provider: payments.mode(), by: req.user.id });
        started = true;
        db.commit();

        const transfer = await payments.initiateTransfer({
          amount: domain.netOf(txn),
          currency: 'TZS',
          account: txn.meta && txn.meta.account,
          method: txn.method,
          reference: txn.id,
          narration: `Ship Transfer payout ${txn.id}`,
          beneficiaryName: user.name,
        });

        txn.meta = {
          ...(txn.meta || {}),
          provider: transfer.provider,
          providerRef: transfer.providerRef,
          sandbox: Boolean(transfer.sandbox),
          payoutMessage: transfer.message,
        };
        const done = ['completed', 'successful'].includes(String(transfer.status).toLowerCase());
        const result = done
          ? domain.completePayout(state, txn, { providerRef: transfer.providerRef, source: 'provider' })
          : { txn, user };
        db.commit();

        return res.json({
          transaction: domain.serializeTxn(txn),
          user: domain.publicUser(state, result.user),
          payout: {
            mode: payments.mode(),
            status: txn.status,
            providerRef: transfer.providerRef,
            sandbox: Boolean(transfer.sandbox),
            message: transfer.message,
          },
        });
      } catch (err) {
        if (started) domain.failPayout(state, txn, err.message);
        db.commit();
        if (err instanceof payments.PaymentError) {
          return res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
        }
        return res.status(err.status || 500).json({ error: err.message });
      }
    }

    try {
      const result = domain.decideRequest(state, txn.id, action, body.note);
      db.commit();
      return res.json({
        transaction: domain.serializeTxn(result.txn),
        user: domain.publicUser(state, result.user),
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ---------- Admin panel (independent password and sessions) ----------
  const adminLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });

  function adminTokenFrom(req) {
    const header = req.get('authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  function adminRoute(handler) {
    return (req, res, next) => {
      try {
        adminpanel.requireSession(state, adminTokenFrom(req));
        res.json(handler(req));
      } catch (err) {
        next(err);
      }
    };
  }

  app.post('/api/apanel/login', adminLimiter, (req, res, next) => {
    try {
      res.json(adminpanel.login(state, (req.body || {}).password));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/apanel/logout', (req, res, next) => {
    try {
      res.json(adminpanel.logout(state, adminTokenFrom(req)));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/apanel/overview', adminRoute(() => adminpanel.overview(state)));

  app.get(
    '/api/apanel/members',
    adminRoute(() => ({ members: adminpanel.members(state) })),
  );

  app.get(
    '/api/apanel/members/:id/password',
    adminRoute((req) => adminpanel.revealPassword(state, req.params.id)),
  );

  app.post(
    '/api/apanel/members/:id/password',
    adminRoute((req) => adminpanel.setPassword(state, req.params.id, req.body || {})),
  );

  app.post(
    '/api/apanel/members/:id/balance',
    adminRoute((req) => adminpanel.adjustBalance(state, req.params.id, req.body || {})),
  );

  app.post(
    '/api/apanel/members/:id/withdraw-block',
    adminRoute((req) => adminpanel.setWithdrawBlocked(state, req.params.id, req.body || {})),
  );

  app.delete(
    '/api/apanel/members/:id',
    adminRoute((req) => adminpanel.deleteMember(state, req.params.id)),
  );

  app.get(
    '/api/apanel/deposit-numbers',
    adminRoute(() => ({ depositNumbers: adminpanel.depositNumbers(state) })),
  );

  app.post(
    '/api/apanel/deposit-numbers',
    adminRoute((req) => adminpanel.saveDepositNumber(state, req.body || {})),
  );

  app.delete(
    '/api/apanel/deposit-numbers/:id',
    adminRoute((req) => adminpanel.deleteDepositNumber(state, req.params.id)),
  );

  app.get(
    '/api/apanel/requests',
    adminRoute((req) => adminpanel.requests(state, req.query.type)),
  );

  app.post(
    '/api/apanel/requests/:id/decision',
    adminRoute((req) => adminpanel.decide(state, req.params.id, req.body || {})),
  );

  app.post(
    '/api/apanel/password',
    adminRoute((req) => adminpanel.changePassword(state, req.body || {})),
  );

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'This API route does not exist' });
  });

  // ---------- Tovuti ----------
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h', index: 'index.html' }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (path.extname(req.path)) return next();
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    if (err instanceof domain.ApiError || err instanceof adminpanel.AdminError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    console.error('[api]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
