'use strict';

/* Ship Transfer — single page app (English) */

const TOKEN_KEY = 'ship.transfer.token';

const state = {
  token: null,
  user: null,
  config: null,
  view: 'home',
  filter: 'all',
  transactions: [],
  investments: [],
  invite: null,
  admin: null,
  pendingDeposit: null,
  investLevel: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function tzs(amount) {
  const n = Number(amount || 0);
  return `TZS ${Math.round(n).toLocaleString('en-US')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDay(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
}

let toastTimer = null;
function toast(message, isError) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 4200);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || `Request failed (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data || {};
}

/* ---------------- auth ---------------- */

function showAuth() {
  $('#auth-screen').classList.remove('is-hidden');
  $('#app-screen').classList.add('is-hidden');
}

function showApp() {
  $('#auth-screen').classList.add('is-hidden');
  $('#app-screen').classList.remove('is-hidden');
  renderChrome();
  go(state.view || 'home');
}

function setAuthTab(tab) {
  $$('[data-auth-tab]').forEach((btn) => {
    const active = btn.dataset.authTab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $$('[data-auth-pane]').forEach((pane) => {
    pane.classList.toggle('is-hidden', pane.dataset.authPane !== tab);
  });
}

function sessionUser(payload) {
  state.token = payload.token || state.token;
  state.user = payload.user || state.user;
  if (payload.packages) state.config = { ...(state.config || {}), packages: payload.packages };
  if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
}

async function submitAuth(form, path) {
  const body = {};
  new FormData(form).forEach((value, key) => {
    body[key] = String(value).trim();
  });
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const data = await api(path, { method: 'POST', body });
    sessionUser(data);
    form.reset();
    showApp();
    toast(`Welcome, ${state.user.name.split(' ')[0]}!`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = null;
  state.user = null;
  state.admin = null;
  state.transactions = [];
  state.investments = [];
  localStorage.removeItem(TOKEN_KEY);
  showAuth();
  setAuthTab('login');
}

/* ---------------- chrome ---------------- */

function renderChrome() {
  if (!state.user) return;
  $('#top-profit').textContent = tzs(state.user.balance);
  $('#top-capital').textContent = tzs(state.user.capital);
  $$('.nav-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.go === state.view));
}

function setUser(user) {
  if (user) state.user = user;
  renderChrome();
}

async function refreshMe() {
  const data = await api('/api/me');
  setUser(data.user);
  if (data.packages) state.config = { ...(state.config || {}), packages: data.packages };
  return data.user;
}

/* ---------------- shared bits ---------------- */

function statusBadge(txn) {
  const status = txn.status === 'processing' ? 'processing' : txn.status;
  const label = {
    pending: 'Pending',
    processing: 'Paying out',
    completed: 'Completed',
    rejected: 'Rejected',
    failed: 'Failed',
  }[status] || status;
  return `<span class="badge ${esc(status)}">${esc(label)}</span>`;
}

function txnRow(txn) {
  const inflow = ['deposit', 'profit', 'signup_bonus', 'invite_bonus'].includes(txn.type);
  const icons = {
    deposit: '↓',
    withdraw: '↑',
    invest: '🚢',
    profit: '◆',
    signup_bonus: '★',
    invite_bonus: '＋',
  };
  const detail = [];
  if (txn.method) detail.push(txn.method);
  if (txn.type === 'withdraw' && txn.fee) detail.push(`fee ${tzs(txn.fee)} · you get ${tzs(txn.net)}`);
  if (txn.createdAt) detail.push(fmtDate(txn.createdAt));
  const amountLabel = txn.type === 'withdraw' ? `− ${tzs(txn.amount)}` : `${inflow ? '+' : '−'} ${tzs(txn.amount)}`;
  return `
    <div class="row">
      <div class="row-ico ${txn.type === 'withdraw' ? 'out' : inflow ? '' : 'gold'}">${icons[txn.type] || '•'}</div>
      <div class="row-main">
        <strong>${esc(txn.label)}${txn.type === 'invest' && txn.note ? '' : ''}</strong>
        <span>${esc(detail.join(' · ') || txn.note || '')}</span>
      </div>
      <div class="row-amt">
        <strong class="${inflow ? 'in' : 'out'}">${amountLabel}</strong>
        ${statusBadge(txn)}
      </div>
    </div>`;
}

function windowNotice(window = {}) {
  const open = window.open !== false;
  return `
    <div class="notice ${open ? 'open' : 'closed'}">
      <div>
        <strong>${open ? 'Withdrawals are open now' : 'Withdrawals are closed'}</strong>
        ${esc(window.message || '')} Monday – Friday, 10:00 – 17:00 EAT.
      </div>
    </div>`;
}

function rulesCard() {
  const rules = (state.config && state.config.rules) || {};
  return `
    <div class="card">
      <div class="section-title"><h3>Withdrawal rules</h3></div>
      <ul class="rules">
        <li>Minimum withdrawal: <b>${tzs(rules.minWithdraw || 3000)}</b></li>
        <li>Service fee: <b>${Math.round((rules.withdrawFeeRate || 0.1) * 100)}%</b> of every withdrawal</li>
        <li>Withdrawal days: <b>Monday – Friday only</b> (Saturday &amp; Sunday closed)</li>
        <li>Withdrawal hours: <b>10:00 – 17:00 EAT</b></li>
        <li>Only <b>profit</b> can be withdrawn — <b>capital stays locked</b></li>
        <li>No daily profit is credited on Saturday or Sunday</li>
      </ul>
    </div>`;
}

/* ---------------- views ---------------- */

function viewHome() {
  const u = state.user;
  const recent = state.transactions.slice(0, 5);
  return `
    <section class="card card-hero">
      <h2>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc(u.name.split(' ')[0])}</h2>
      <p>Level ${esc(u.vipLevel || 0)} investor · ${esc(u.activeInvestments)} active ship${u.activeInvestments === 1 ? '' : 's'} · member since ${esc(fmtDay(u.createdAt))}</p>
    </section>

    <div class="grid-4">
      <div class="stat green"><em>Profit balance</em><strong>${tzs(u.balance)}</strong><span class="tiny muted">Withdrawable</span></div>
      <div class="stat gold"><em>Capital</em><strong>${tzs(u.capital)}</strong><span class="tiny muted">Locked</span></div>
      <div class="stat"><em>Profit earned</em><strong>${tzs(u.totalProfit)}</strong><span class="tiny muted">All time</span></div>
      <div class="stat"><em>Referral bonus</em><strong>${tzs(u.totalBonus)}</strong><span class="tiny muted">All time</span></div>
    </div>

    ${windowNotice(u.withdrawal)}

    <div class="actions">
      <button class="action" data-go="deposit"><span class="ico">↓</span>Deposit</button>
      <button class="action" data-go="withdraw"><span class="ico">↑</span>Withdraw</button>
      <button class="action" data-go="package"><span class="ico">🚢</span>Package</button>
      <button class="action" data-go="invest"><span class="ico">◆</span>Invest</button>
      <button class="action" data-go="invite"><span class="ico">＋</span>Invite</button>
    </div>

    <div class="card">
      <div class="section-title">
        <h3>Recent activity</h3>
        <button class="btn btn-ghost btn-sm" data-go="history" type="button">View all</button>
      </div>
      <div class="list">
        ${recent.length ? recent.map(txnRow).join('') : '<p class="muted small">No activity yet. Make your first deposit to rent a ship.</p>'}
      </div>
    </div>

    ${rulesCard()}`;
}

function viewDeposit() {
  const cfg = state.config || {};
  const methods = cfg.depositMethods || [];
  const pay = cfg.payments || {};
  const live = Boolean(pay.live);
  const pending = state.pendingDeposit;
  const options = methods
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');

  const pendingCard = pending
    ? `
      <div class="card">
        <div class="section-title"><h3>Deposit ${statusBadge(pending)}</h3><span class="muted small">${tzs(pending.amount)}</span></div>
        <div class="kv">
          <div><span>Reference</span><b>${esc(pending.id.slice(0, 8).toUpperCase())}</b></div>
          <div><span>Method</span><b>${esc(pending.method)}</b></div>
          ${pending.phone ? `<div><span>Phone</span><b>${esc(pending.phone)}</b></div>` : ''}
          <div><span>Fee</span><b>TZS 0</b></div>
        </div>
        <p class="small muted" style="margin:12px 0 0">${
          pending.channel === 'mobile_money'
            ? 'Approve the payment prompt on your phone. The deposit is credited as soon as the payment is confirmed.'
            : 'Transfer the amount to the account shown below, then an admin approves your deposit.'
        }</p>
        ${pending.channel === 'mobile_money' && !live
          ? `<button class="btn btn-gold btn-sm" style="margin-top:12px" data-action="simulate" data-id="${esc(pending.id)}" type="button">Simulate payment (sandbox)</button>`
          : ''}
      </div>`
    : '';

  return `
    <section class="card card-hero">
      <h2>Deposit capital</h2>
      <p>Deposits become locked capital. Use capital to rent a ship and start earning profit.</p>
    </section>

    <div class="card">
      <div class="section-title"><h3>New deposit</h3><span class="muted small">Minimum ${tzs(cfg.minDeposit || 5000)}</span></div>
      <form id="deposit-form" class="form" novalidate>
        <label class="field">
          <span>Amount (TZS)</span>
          <input type="number" name="amount" min="${cfg.minDeposit || 5000}" step="500" placeholder="50000" required />
        </label>
        <label class="field">
          <span>Payment method</span>
          <select name="method" id="deposit-method" required>${options}</select>
        </label>
        <label class="field">
          <span>Phone number for mobile money</span>
          <input type="tel" name="phone" id="deposit-phone" value="${esc(state.user.phone)}" placeholder="0712 345 678" />
        </label>
        <button class="btn btn-primary" type="submit">Continue to payment</button>
        <p class="form-note">${live ? 'You will get a payment prompt on your phone.' : 'Payments are in test mode — use the simulate button after creating the deposit.'}</p>
      </form>
    </div>

    ${pendingCard}

    <div class="card">
      <div class="section-title"><h3>Company accounts</h3></div>
      <div class="kv">
        ${methods
          .map(
            (m) => `<div><span>${esc(m.label)}</span><b>${esc(m.account)}</b></div>`,
          )
          .join('')}
      </div>
      <p class="small muted" style="margin:12px 0 0">Account name: <strong>SHIP TRANSFER LTD</strong></p>
    </div>`;
}

function viewWithdraw() {
  const u = state.user;
  const cfg = state.config || {};
  const options = (cfg.withdrawOptions || [])
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');
  return `
    <section class="card card-hero">
      <h2>Withdraw profit</h2>
      <p>Available profit: <strong>${tzs(u.balance)}</strong> · Capital ${tzs(u.capital)} is locked.</p>
    </section>

    ${windowNotice(u.withdrawal)}

    <div class="card">
      <div class="section-title"><h3>Withdrawal request</h3><span class="muted small">Min ${tzs(cfg.minWithdraw || 3000)}</span></div>
      <form id="withdraw-form" class="form" novalidate>
        <label class="field">
          <span>Amount (TZS)</span>
          <input type="number" name="amount" id="withdraw-amount" min="${cfg.minWithdraw || 3000}" step="100" placeholder="5000" required />
        </label>
        <div class="kv" id="withdraw-summary">
          <div><span>Service fee (10%)</span><b id="withdraw-fee">TZS 0</b></div>
          <div><span>You receive</span><b id="withdraw-net">TZS 0</b></div>
        </div>
        <label class="field">
          <span>Payout method</span>
          <select name="method" id="withdraw-method" required>${options}</select>
        </label>
        <label class="field">
          <span>Phone number / account</span>
          <input type="text" name="account" id="withdraw-account" value="${esc(u.phone)}" required />
        </label>
        <button class="btn btn-primary" type="submit" ${u.withdrawal && u.withdrawal.open ? '' : 'disabled'}>
          ${u.withdrawal && u.withdrawal.open ? 'Request withdrawal' : 'Withdrawals closed'}
        </button>
        <p class="form-note">Requests made outside Monday – Friday, 10:00 – 17:00 EAT are not accepted.</p>
      </form>
    </div>

    ${rulesCard()}`;
}

function shipCard(pkg, compact) {
  return `
    <article class="ship-card">
      <div class="ship-media">
        <span class="ship-level">Level ${esc(pkg.level)}</span>
        ${pkg.tag ? `<span class="ship-tag">${esc(pkg.tag)}</span>` : ''}
        <img src="${esc(pkg.image)}" alt="${esc(pkg.shipName)}" loading="lazy" />
      </div>
      <div class="ship-body">
        <h4 class="ship-name">${esc(pkg.shipName)}</h4>
        <div class="ship-capital">Capital <b>${tzs(pkg.capital)}</b></div>
        <div class="ship-profit">
          <strong>${tzs(pkg.dailyProfit)}</strong>
          <em>per business day</em>
        </div>
        ${compact ? '' : `<ul class="ship-perks">${pkg.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`}
        <div class="tiny muted">${tzs(pkg.dailyProfit * pkg.days)} total over ${pkg.days} profit days</div>
        <button class="btn btn-gold btn-sm" data-action="pick-ship" data-id="${esc(pkg.id)}" type="button">
          Rent this ship
        </button>
      </div>
    </article>`;
}

function viewPackage() {
  const packages = (state.config && state.config.packages) || [];
  return `
    <section class="card card-hero">
      <h2>Ship packages</h2>
      <p>${packages.length} levels · rent with capital · profit credited 24 hours after renting.</p>
    </section>
    <div class="notice info">
      <div><strong>How it works</strong> Choose a level, rent the ship with capital, and receive the daily profit every business day for ${packages[0] ? packages[0].days : 30} days. Saturday and Sunday pay nothing.</div>
    </div>
    <div class="grid-3">
      ${packages.map((p) => shipCard(p)).join('')}
    </div>`;
}

function viewInvest() {
  const packages = (state.config && state.config.packages) || [];
  const selected = packages.find((p) => p.id === state.investLevel) || packages[0] || null;
  const list = state.investments;
  return `
    <section class="card card-hero">
      <h2>Invest in a ship</h2>
      <p>Capital ${tzs(state.user.capital)} available · profit starts 24 hours after renting.</p>
    </section>

    <div class="card">
      <div class="section-title"><h3>Rent a ship</h3></div>
      <form id="invest-form" class="form" novalidate>
        <label class="field">
          <span>Ship level</span>
          <select name="packageId" id="invest-package" required>
            ${packages
              .map(
                (p) =>
                  `<option value="${esc(p.id)}" ${selected && p.id === selected.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.shipName)} · capital ${tzs(p.capital)}</option>`,
              )
              .join('')}
          </select>
        </label>
        ${
          selected
            ? `<div class="grid-2">
                <div class="stat gold"><em>Capital required</em><strong>${tzs(selected.capital)}</strong></div>
                <div class="stat green"><em>Profit per business day</em><strong>${tzs(selected.dailyProfit)}</strong></div>
              </div>
              <img src="${esc(selected.image)}" alt="${esc(selected.shipName)}" style="width:100%;max-width:320px;margin:0 auto" />`
            : ''
        }
        <button class="btn btn-primary" type="submit">Rent ship with capital</button>
        <p class="form-note">The exact capital is taken from your capital balance. Profit balance cannot be used.</p>
      </form>
    </div>

    <div class="card">
      <div class="section-title"><h3>My ships</h3><span class="muted small">${list.length} total</span></div>
      <div class="list">
        ${
          list.length
            ? list
                .map(
                  (inv) => `
          <div class="row">
            <div class="row-ico">🚢</div>
            <div class="row-main" style="flex:1">
              <strong>${esc(inv.shipName)} · ${esc(inv.packageName)}</strong>
              <span>${tzs(inv.dailyProfit)}/day · earned ${tzs(inv.earned)} of ${tzs(inv.projectedTotal)}</span>
              <div class="progress ${inv.status === 'active' ? '' : 'gold'}" style="margin-top:6px">
                <i style="width:${Math.min(100, inv.progress)}%"></i>
              </div>
              <span>${inv.daysPaid}/${inv.days} profit days${inv.status === 'active' && inv.nextPayoutAt ? ` · next ${fmtDate(inv.nextPayoutAt)}` : ''}</span>
            </div>
            <div class="row-amt"><strong>${tzs(inv.amount)}</strong><span class="badge ${inv.status === 'active' ? 'processing' : 'completed'}">${esc(inv.status === 'active' ? 'Sailing' : 'Finished')}</span></div>
          </div>`,
                )
                .join('')
            : '<p class="muted small">No ships yet. Rent one above and profit starts after 24 hours.</p>'
        }
      </div>
    </div>`;
}

function viewInvite() {
  const invite = state.invite || { code: state.user.referralCode, invited: [], totalInvited: 0, totalEarned: 0, bonusPercent: 10 };
  const link = `${location.origin}/?ref=${encodeURIComponent(invite.code || '')}`;
  return `
    <section class="card card-hero">
      <h2>Invite friends</h2>
      <p>Earn ${esc(invite.bonusPercent || 10)}% of every invited member's first deposit — credited automatically.</p>
    </section>

    <div class="grid-3">
      <div class="stat green"><em>Invited members</em><strong>${esc(invite.totalInvited)}</strong></div>
      <div class="stat gold"><em>Bonus earned</em><strong>${tzs(invite.totalEarned)}</strong></div>
      <div class="stat"><em>Bonus rate</em><strong>${esc(invite.bonusPercent || 10)}%</strong></div>
    </div>

    <div class="card">
      <div class="section-title"><h3>Your invite code</h3></div>
      <div class="kv">
        <div><span>Code</span><b>${esc(invite.code)}</b></div>
        <div><span>Link</span><b style="word-break:break-all">${esc(link)}</b></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" data-action="copy-invite" data-link="${esc(link)}" type="button">Copy invite link</button>
        <button class="btn btn-ghost btn-sm" data-action="share-invite" data-link="${esc(link)}" data-code="${esc(invite.code)}" type="button">Share</button>
      </div>
      <p class="small muted" style="margin:12px 0 0">Your friend enters the code when creating an account. When their first deposit is confirmed, ${esc(invite.bonusPercent || 10)}% lands in your profit balance.</p>
    </div>

    <div class="card">
      <div class="section-title"><h3>Invited members</h3></div>
      <div class="list">
        ${
          (invite.invited || []).length
            ? invite.invited
                .map(
                  (m) => `
          <div class="row">
            <div class="row-ico">☺</div>
            <div class="row-main"><strong>${esc(m.name)}</strong><span>Joined ${esc(fmtDate(m.joinedAt))}</span></div>
            <div class="row-amt"><span class="badge ${m.rewarded ? 'completed' : 'pending'}">${m.rewarded ? 'Bonus paid' : 'Waiting deposit'}</span></div>
          </div>`,
                )
                .join('')
            : '<p class="muted small">No invited members yet. Share your link to start earning.</p>'
        }
      </div>
    </div>`;
}

function viewHistory() {
  const filters = [
    ['all', 'All'],
    ['deposit', 'Deposits'],
    ['withdraw', 'Withdrawals'],
    ['invest', 'Ship rentals'],
    ['profit', 'Profit'],
    ['invite_bonus', 'Referral bonus'],
  ];
  return `
    <section class="card card-hero">
      <h2>Transaction history</h2>
      <p>Deposits, withdrawals, ship rentals, daily profit and bonuses.</p>
    </section>
    <div class="filters">
      ${filters
        .map(
          ([id, label]) =>
            `<button class="filter ${state.filter === id ? 'is-active' : ''}" data-filter="${id}" type="button">${label}</button>`,
        )
        .join('')}
    </div>
    <div class="card">
      <div class="list">
        ${
          state.transactions.length
            ? state.transactions.map(txnRow).join('')
            : '<p class="muted small">No transactions for this filter.</p>'
        }
      </div>
    </div>`;
}

function viewAccount() {
  const u = state.user;
  return `
    <section class="card card-hero">
      <h2>My account</h2>
      <p>${esc(u.name)} · ${esc(u.email)}</p>
    </section>
    <div class="card">
      <div class="section-title"><h3>Profile</h3></div>
      <div class="kv">
        <div><span>Name</span><b>${esc(u.name)}</b></div>
        <div><span>Email</span><b>${esc(u.email)}</b></div>
        <div><span>Phone</span><b>${esc(u.phone)}</b></div>
        <div><span>Level</span><b>Level ${esc(u.vipLevel || 0)}</b></div>
        <div><span>Invite code</span><b>${esc(u.referralCode)}</b></div>
        <div><span>Joined</span><b>${esc(fmtDate(u.createdAt))}</b></div>
      </div>
    </div>
    <div class="card">
      <div class="section-title"><h3>Change password</h3></div>
      <form id="password-form" class="form" novalidate>
        <label class="field"><span>Current password</span><input type="password" name="currentPassword" required /></label>
        <label class="field"><span>New password</span><input type="password" name="newPassword" minlength="6" required /></label>
        <button class="btn btn-primary" type="submit">Update password</button>
      </form>
    </div>
    ${u.role === 'admin' ? '<button class="btn btn-gold" data-go="admin" type="button">Open admin panel</button>' : ''}
    <button class="btn btn-ghost" data-action="logout" type="button">Sign out</button>`;
}

function viewAdmin() {
  const data = state.admin;
  if (!data) return '<div class="card"><p class="muted small">Loading admin data…</p></div>';
  const stats = data.stats || {};
  const requests = data.requests || [];
  return `
    <section class="card card-hero">
      <h2>Admin panel</h2>
      <p>Approve deposits and withdrawals, monitor payouts.</p>
    </section>
    <div class="grid-4">
      <div class="stat"><em>Members</em><strong>${esc(stats.users || 0)}</strong></div>
      <div class="stat gold"><em>Pending deposits</em><strong>${esc(stats.pendingDeposits || 0)}</strong></div>
      <div class="stat gold"><em>Pending withdrawals</em><strong>${esc(stats.pendingWithdrawals || 0)}</strong></div>
      <div class="stat green"><em>Total deposited</em><strong>${tzs(stats.totalDeposited || 0)}</strong></div>
    </div>
    <div class="card">
      <div class="section-title"><h3>Pending requests</h3><span class="muted small">${requests.length}</span></div>
      <div class="list">
        ${
          requests.length
            ? requests
                .map(
                  (t) => `
          <div class="row">
            <div class="row-ico ${t.type === 'withdraw' ? 'out' : ''}">${t.type === 'withdraw' ? '↑' : '↓'}</div>
            <div class="row-main" style="flex:1">
              <strong>${esc(t.label)} · ${tzs(t.amount)}</strong>
              <span>${esc(t.user ? `${t.user.name} · ${t.user.phone}` : 'Unknown')} · ${esc(t.method || '')} · ${esc(fmtDate(t.createdAt))}</span>
              ${t.type === 'withdraw' ? `<span>Fee ${tzs(t.fee)} · pays out ${tzs(t.net)}</span>` : ''}
            </div>
            <div class="row-amt" style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" data-action="decide" data-id="${esc(t.id)}" data-decision="approve" type="button">Approve</button>
              <button class="btn btn-ghost btn-sm" data-action="decide" data-id="${esc(t.id)}" data-decision="reject" type="button">Reject</button>
            </div>
          </div>`,
                )
                .join('')
            : '<p class="muted small">No pending requests.</p>'
        }
      </div>
    </div>
    <div class="card">
      <div class="section-title"><h3>Payouts in progress</h3></div>
      <div class="list">
        ${
          (data.payouts || []).length
            ? data.payouts
                .map(
                  (t) => `
          <div class="row">
            <div class="row-ico gold">↑</div>
            <div class="row-main"><strong>${tzs(t.net)} to ${esc(t.user ? t.user.name : 'member')}</strong><span>${esc(t.method || '')} · ${esc(fmtDate(t.createdAt))}</span></div>
            <div class="row-amt">${statusBadge(t)}</div>
          </div>`,
                )
                .join('')
            : '<p class="muted small">Nothing is being paid out right now.</p>'
        }
      </div>
    </div>
    <button class="btn btn-ghost" data-go="home" type="button">Back to dashboard</button>`;
}

/* ---------------- data loading ---------------- */

async function loadView(view) {
  if (view === 'history') {
    const query = state.filter === 'all' ? '' : `?type=${encodeURIComponent(state.filter)}`;
    const data = await api(`/api/transactions${query}`);
    state.transactions = data.transactions || [];
  }
  if (view === 'invest' || view === 'package') {
    const data = await api('/api/investments');
    state.investments = data.investments || [];
  }
  if (view === 'invite') {
    state.invite = await api('/api/invite');
  }
  if (view === 'admin') {
    state.admin = await api('/api/admin/overview');
  }
}

async function go(view) {
  state.view = view;
  const renderers = {
    home: viewHome,
    deposit: viewDeposit,
    withdraw: viewWithdraw,
    package: viewPackage,
    invest: viewInvest,
    invite: viewInvite,
    history: viewHistory,
    account: viewAccount,
    admin: viewAdmin,
  };
  try {
    await loadView(view);
  } catch (err) {
    toast(err.message, true);
  }
  const render = renderers[view] || viewHome;
  $('#view').innerHTML = render();
  renderChrome();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- actions ---------------- */

async function submitDeposit(form) {
  const body = {};
  new FormData(form).forEach((v, k) => {
    body[k] = String(v).trim();
  });
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const data = await api('/api/deposit', { method: 'POST', body });
    state.pendingDeposit = data.transaction;
    setUser(data.user);
    toast(data.payment && data.payment.message ? data.payment.message : 'Deposit created');
    await go('deposit');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

async function submitWithdraw(form) {
  const body = {};
  new FormData(form).forEach((v, k) => {
    body[k] = String(v).trim();
  });
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const data = await api('/api/withdraw', { method: 'POST', body });
    setUser(data.user);
    form.reset();
    toast(`Withdrawal requested. You will receive ${tzs(data.payout.net)} after the 10% fee.`);
    await go('history');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

async function submitInvest(form) {
  const body = {};
  new FormData(form).forEach((v, k) => {
    body[k] = String(v).trim();
  });
  const pkg = ((state.config && state.config.packages) || []).find((p) => p.id === body.packageId);
  if (pkg) body.amount = pkg.capital;
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const data = await api('/api/invest', { method: 'POST', body });
    setUser(data.user);
    toast(`${data.investment.shipName} rented. First profit in 24 hours.`);
    await go('invest');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

async function simulateDeposit(id) {
  try {
    const data = await api(`/api/deposit/${id}/simulate`, { method: 'POST' });
    setUser(data.user);
    state.pendingDeposit = null;
    toast('Deposit credited to your capital.');
    await go('deposit');
  } catch (err) {
    toast(err.message, true);
  }
}

async function decide(id, decision) {
  try {
    const data = await api(`/api/admin/transactions/${id}/decision`, {
      method: 'POST',
      body: { action: decision },
    });
    state.admin = null;
    toast(`${data.transaction.label} ${decision === 'approve' ? 'approved' : 'rejected'}.`);
    await go('admin');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- wiring ---------------- */

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-auth-tab]');
  if (tab) return setAuthTab(tab.dataset.authTab);

  const nav = event.target.closest('[data-go]');
  if (nav) {
    event.preventDefault();
    return go(nav.dataset.go);
  }

  const filter = event.target.closest('[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    return go('history');
  }

  const pick = event.target.closest('[data-action="pick-ship"]');
  if (pick) {
    state.investLevel = pick.dataset.id;
    return go('invest');
  }

  const sim = event.target.closest('[data-action="simulate"]');
  if (sim) return simulateDeposit(sim.dataset.id);

  const decision = event.target.closest('[data-action="decide"]');
  if (decision) return decide(decision.dataset.id, decision.dataset.decision);

  const copy = event.target.closest('[data-action="copy-invite"]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.link);
      toast('Invite link copied.');
    } catch (err) {
      toast(copy.dataset.link);
    }
    return;
  }

  const share = event.target.closest('[data-action="share-invite"]');
  if (share) {
    const text = `Join Ship Transfer with my code ${share.dataset.code} and earn profit from ships: ${share.dataset.link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Ship Transfer', text, url: share.dataset.link });
      } catch (err) {
        /* dismissed */
      }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        toast('Invite message copied.');
      } catch (err) {
        toast(share.dataset.link);
      }
    }
    return;
  }

  const out = event.target.closest('[data-action="logout"]');
  if (out) return logout();
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();
  if (form.id === 'login-form') return submitAuth(form, '/api/auth/login');
  if (form.id === 'register-form') return submitAuth(form, '/api/auth/register');
  if (form.id === 'deposit-form') return submitDeposit(form);
  if (form.id === 'withdraw-form') return submitWithdraw(form);
  if (form.id === 'invest-form') return submitInvest(form);
  if (form.id === 'password-form') {
    const body = {};
    new FormData(form).forEach((v, k) => {
      body[k] = String(v).trim();
    });
    try {
      await api('/api/account/password', { method: 'POST', body });
      toast('Password changed. Please sign in again.');
      logout();
    } catch (err) {
      toast(err.message, true);
    }
    return undefined;
  }
  return undefined;
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'withdraw-amount') {
    const amount = Number(event.target.value || 0);
    const fee = Math.round(amount * 0.1);
    const feeEl = $('#withdraw-fee');
    const netEl = $('#withdraw-net');
    if (feeEl) feeEl.textContent = tzs(fee);
    if (netEl) netEl.textContent = tzs(Math.max(0, amount - fee));
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'invest-package') {
    state.investLevel = event.target.value;
    go('invest');
  }
});

async function boot() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');
  if (ref) {
    const input = $('#register-invite');
    if (input) input.value = ref.toUpperCase();
    setAuthTab('register');
  }

  try {
    state.config = await api('/api/config');
  } catch (err) {
    toast('Cannot reach the server. Please reload.', true);
  }

  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    showAuth();
    return;
  }
  state.token = token;
  try {
    await refreshMe();
    const data = await api('/api/transactions');
    state.transactions = data.transactions || [];
    showApp();
  } catch (err) {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    showAuth();
  }
}

boot();
