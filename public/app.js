'use strict';

(function () {
  const TOKEN_KEY = 'ship_token';
  const STATUS_LABEL = { pending: 'Inasubiri', completed: 'Imekamilika', rejected: 'Imekataliwa' };
  const INFLOW = new Set(['deposit', 'profit', 'signup_bonus', 'invite_bonus']);

  const app = {
    user: null,
    packages: [],
    config: null,
    txns: [],
    investments: [],
    invite: null,
    admin: null,
    view: 'dashboard',
    filter: 'all',
    dialogSubmit: null,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => map[c]);
  }

  function tzs(amount) {
    return 'TZS ' + Number(amount || 0).toLocaleString('en-US');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('sw-TZ', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return String(iso);
    }
  }

  let toastTimer = null;
  function toast(message, kind) {
    const box = $('#toast');
    box.textContent = message;
    box.className = 'toast is-visible' + (kind ? ` toast--${kind}` : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.className = 'toast';
    }, 4200);
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await fetch('/api' + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      throw new Error('Hakuna muunganisho wa mtandao. Jaribu tena.');
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      if (response.status === 401 && opts.auth !== false) {
        clearSession();
        showAuth();
      }
      throw new Error((data && data.error) || 'Hitilafu imetokea. Jaribu tena.');
    }
    return data || {};
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    app.user = null;
  }

  /* ---------------- Auth screen ---------------- */
  function switchAuthTab(tab) {
    $$('[data-auth-tab]').forEach((btn) => {
      if (btn.classList.contains('auth-tab')) btn.classList.toggle('is-active', btn.dataset.authTab === tab);
    });
    $$('[data-auth-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.authPane !== tab;
    });
  }

  function showAuth() {
    $('#app-screen').hidden = true;
    $('#auth-screen').hidden = false;
    window.scrollTo(0, 0);
  }

  function showApp() {
    $('#auth-screen').hidden = true;
    $('#app-screen').hidden = false;
    renderShell();
    switchView(app.view || 'dashboard');
  }

  async function handleLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          email: form.email.value.trim(),
          password: form.password.value,
        },
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      form.reset();
      await loadAll();
      app.view = 'dashboard';
      showApp();
      toast(`Karibu ${app.user.name.split(' ')[0]}!`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        auth: false,
        body: {
          name: form.name.value.trim(),
          phone: form.phone.value.trim(),
          email: form.email.value.trim(),
          password: form.password.value,
          inviteCode: form.inviteCode.value.trim(),
        },
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      form.reset();
      await loadAll();
      app.view = 'dashboard';
      showApp();
      toast('Akaunti yako imefunguliwa. Karibu Ship Transfer!', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function handleLogout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    clearSession();
    showAuth();
    switchAuthTab('login');
    toast('Umetoka kwenye akaunti.', 'ok');
  }

  /* ---------------- Data ---------------- */
  async function loadAll() {
    const [me, txns, investments, invite] = await Promise.all([
      api('/me'),
      api('/transactions'),
      api('/investments'),
      api('/invite'),
    ]);
    app.user = me.user;
    app.packages = me.packages || app.packages;
    app.txns = txns.transactions || [];
    app.investments = investments.investments || [];
    app.invite = invite;
    renderAll();
  }

  async function refresh() {
    try {
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- Navigation ---------------- */
  function switchView(view) {
    app.view = view;
    $$('.view').forEach((section) => section.classList.toggle('is-active', section.dataset.view === view));
    $$('.side-nav .nav-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.go === view));
    $$('.bottom-nav .bn-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.go === view));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (view === 'admin') loadAdmin();
    if (view === 'history') renderHistory();
  }

  /* ---------------- Rendering ---------------- */
  function renderShell() {
    if (!app.user) return;
    const u = app.user;
    const first = (u.name || '').split(' ')[0] || 'mteja';
    $('#top-name').textContent = first;
    $('#top-greeting').textContent = greeting();
    $('#top-vip').textContent = `VIP ${u.vipLevel || 0}`;
    $('#top-avatar').textContent = (u.name || 'S').trim().charAt(0).toUpperCase();
    $('#side-balance').textContent = tzs(u.balance);
    $$('.nav-item--admin').forEach((btn) => {
      btn.hidden = u.role !== 'admin';
    });
    $('#withdraw-balance').textContent = tzs(u.balance);
    $('#dash-vip').textContent = `VIP ${u.vipLevel || 0}`;
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Habari za asubuhi';
    if (hour < 17) return 'Habari za mchana';
    return 'Habari za jioni';
  }

  function renderAll() {
    renderShell();
    renderDashboard();
    renderPackages();
    renderHistory();
    renderInvite();
    renderAccount();
    if (app.view === 'admin') loadAdmin();
  }

  function emptyRow(text) {
    return `<p class="empty">${esc(text)}</p>`;
  }

  function txnRow(txn) {
    const inflow = INFLOW.has(txn.type);
    const sign = inflow ? '+' : '−';
    const cls = inflow ? 'amount--in' : 'amount--out';
    const status = STATUS_LABEL[txn.status] || txn.status;
    const meta = [txn.method, txn.reference ? `Ref: ${txn.reference}` : null].filter(Boolean).join(' · ');
    return `
      <div class="row">
        <div class="row__main">
          <strong>${esc(txn.label || txn.type)}</strong>
          <span>${esc(fmtDate(txn.createdAt))}${meta ? ' · ' + esc(meta) : ''}</span>
        </div>
        <div class="row__side">
          <strong class="${cls}">${sign} ${esc(tzs(txn.amount))}</strong>
          <span class="status status--${esc(txn.status)}">${esc(status)}</span>
        </div>
      </div>`;
  }

  function renderDashboard() {
    const u = app.user;
    if (!u) return;
    $('#dash-balance').textContent = tzs(u.balance);
    $('#dash-profit').textContent = tzs(u.totalProfit);
    $('#dash-active').textContent = String(u.activeInvestments);
    $('#dash-pending').textContent = String(u.pendingCount);

    const active = app.investments.filter((i) => i.status === 'active').slice(0, 3);
    $('#dash-investments').innerHTML = active.length
      ? active
          .map(
            (inv) => `
        <div class="row">
          <div class="row__main">
            <strong>${esc(inv.packageName)} · ${esc(tzs(inv.amount))}</strong>
            <span>${esc(tzs(inv.dailyProfit))}/siku · siku ${inv.daysPaid}/${inv.days}</span>
            <div class="progress"><i style="width:${inv.progress}%"></i></div>
          </div>
          <div class="row__side">
            <strong class="amount--in">${esc(tzs(inv.earned))}</strong>
            <span class="status status--completed">Hai</span>
          </div>
        </div>`,
          )
          .join('')
      : emptyRow('Bado huna uwekezaji hai. Chagua kifurushi cha VIP kuanza.');

    const recent = app.txns.slice(0, 5);
    $('#dash-txns').innerHTML = recent.length ? recent.map(txnRow).join('') : emptyRow('Hakuna muamala bado.');
  }

  function renderPackages() {
    const grid = $('#packages-grid');
    if (!app.packages || !app.packages.length) {
      grid.innerHTML = emptyRow('Vifurushi vinapakiwa...');
      return;
    }
    grid.innerHTML = app.packages
      .map(
        (pkg) => `
      <article class="package${pkg.level === 5 ? ' package--top' : ''}">
        <span class="package__tag">${esc(pkg.tag)}</span>
        <h3 class="package__name">${esc(pkg.name)}</h3>
        <div class="package__rate">${(pkg.dailyRate * 100).toFixed(1)}%<small> / siku</small></div>
        <div class="package__meta">
          <span>Kuanzia ${esc(tzs(pkg.min))}</span>
          <span>Siku ${pkg.days}</span>
        </div>
        <ul>
          ${pkg.perks.map((perk) => `<li>${esc(perk)}</li>`).join('')}
          <li>Faida jumla: ${esc(tzs(pkg.totalProfitAtMin))} kwa ${esc(tzs(pkg.min))}</li>
        </ul>
        <button class="btn btn--primary btn--block" type="button" data-invest="${esc(pkg.id)}">Wekeza ${esc(pkg.name)}</button>
      </article>`,
      )
      .join('');
  }

  function filteredTxns() {
    if (app.filter === 'all') return app.txns;
    if (app.filter === 'bonus') return app.txns.filter((t) => t.type === 'signup_bonus' || t.type === 'invite_bonus');
    return app.txns.filter((t) => t.type === app.filter);
  }

  function renderHistory() {
    const list = filteredTxns();
    $('#history-list').innerHTML = list.length ? list.map(txnRow).join('') : emptyRow('Hakuna muamala wa aina hii.');
    $$('#history-filters .chip-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.filter === app.filter));
  }

  function renderInvite() {
    const invite = app.invite;
    if (!invite) return;
    $('#invite-code').textContent = invite.code;
    const link = `${location.origin}/?ref=${encodeURIComponent(invite.code)}`;
    $('#invite-link').value = link;
    $('#invite-count').textContent = String(invite.totalInvited);
    $('#invite-earned').textContent = tzs(invite.totalEarned);
    $('#invite-list').innerHTML = invite.invited.length
      ? invite.invited
          .map(
            (friend) => `
        <div class="row">
          <div class="row__main">
            <strong>${esc(friend.name)}</strong>
            <span>Alijiunga ${esc(fmtDate(friend.joinedAt))}</span>
          </div>
          <div class="row__side"><span class="chip chip--gold">VIP ${friend.vipLevel}</span></div>
        </div>`,
          )
          .join('')
      : emptyRow('Bado hujapata mwaliko. Shiriki kodi yako na rafiki.');
  }

  function renderAccount() {
    const u = app.user;
    if (!u) return;
    $('#acc-name').textContent = u.name;
    $('#acc-email').textContent = u.email;
    $('#acc-phone').textContent = u.phone;
    $('#acc-code').textContent = u.referralCode;
    $('#acc-vip').textContent = `VIP ${u.vipLevel || 0}`;
    $('#acc-since').textContent = fmtDate(u.createdAt);
  }

  /* ---------------- Actions ---------------- */
  async function handleDeposit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const data = await api('/deposit', {
        method: 'POST',
        body: {
          amount: Number(form.amount.value),
          method: form.method.value,
          reference: form.reference.value.trim(),
        },
      });
      form.reset();
      app.user = data.user;
      await refresh();
      toast('Ombi la amana limewasilishwa. Linasubiri uthibitisho.', 'ok');
      switchView('history');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function handleWithdraw(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const data = await api('/withdraw', {
        method: 'POST',
        body: {
          amount: Number(form.amount.value),
          method: form.method.value,
          account: form.account.value.trim(),
        },
      });
      form.reset();
      app.user = data.user;
      await refresh();
      toast('Ombi la utoaji limewasilishwa. Kiasi kimekatiwa kwenye salio.', 'ok');
      switchView('history');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function openInvestDialog(packageId) {
    const pkg = (app.packages || []).find((p) => p.id === packageId);
    if (!pkg) return;
    const dialog = $('#dialog');
    $('#dialog-title').textContent = `Wekeza ${pkg.name}`;
    $('#dialog-body').innerHTML = `
      <p class="muted">Faida ${(pkg.dailyRate * 100).toFixed(1)}% kwa siku kwa siku ${pkg.days}. Kiasi cha chini ${esc(tzs(pkg.min))}.</p>
      <label class="field">
        <span>Kiasi cha kuwekeza (TZS)</span>
        <input type="number" id="invest-amount" min="${pkg.min}" max="${pkg.max}" step="1000" value="${pkg.min}" />
      </label>
      <div class="pay-box">
        <div class="pay-row"><span>Faida kwa siku</span><strong id="invest-daily">${esc(tzs(Math.round(pkg.min * pkg.dailyRate)))}</strong></div>
        <div class="pay-row"><span>Faida jumla (siku ${pkg.days})</span><strong id="invest-total">${esc(tzs(Math.round(pkg.min * pkg.dailyRate) * pkg.days))}</strong></div>
        <div class="pay-row"><span>Salio lako</span><strong>${esc(tzs(app.user ? app.user.balance : 0))}</strong></div>
      </div>`;

    const input = $('#invest-amount');
    input.addEventListener('input', () => {
      const amount = Number(input.value) || 0;
      const daily = Math.round(amount * pkg.dailyRate);
      $('#invest-daily').textContent = tzs(daily);
      $('#invest-total').textContent = tzs(daily * pkg.days);
    });

    app.dialogSubmit = async () => {
      const amount = Number(input.value);
      const data = await api('/invest', { method: 'POST', body: { packageId: pkg.id, amount } });
      app.user = data.user;
      await refresh();
      toast(`Uwekezaji ${pkg.name} umeanza. Faida inaingia kila siku.`, 'ok');
      switchView('dashboard');
    };
    dialog.showModal();
  }

  async function loadAdmin() {
    if (!app.user || app.user.role !== 'admin') return;
    try {
      const data = await api('/admin/overview');
      app.admin = data;
      renderAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderAdmin() {
    const data = app.admin;
    if (!data) return;
    const s = data.stats;
    $('#admin-stats').innerHTML = `
      <div class="stat"><span>Watumiaji</span><strong>${s.users}</strong></div>
      <div class="stat"><span>Amana zinazosubiri</span><strong>${s.pendingDeposits}</strong></div>
      <div class="stat"><span>Utoaji unazosubiri</span><strong>${s.pendingWithdrawals}</strong></div>
      <div class="stat"><span>Amana jumla</span><strong>${esc(tzs(s.totalDeposited))}</strong></div>
      <div class="stat"><span>Uwekezaji jumla</span><strong>${esc(tzs(s.totalInvested))}</strong></div>`;

    $('#admin-requests').innerHTML = data.requests.length
      ? data.requests
          .map(
            (req) => `
        <div class="row">
          <div class="row__main">
            <strong>${esc(req.label)} · ${esc(tzs(req.amount))} ${req.method ? '· ' + esc(req.method) : ''}</strong>
            <span>${esc(req.user ? req.user.name : '—')} · ${esc(req.user ? req.user.phone : '')} · ${esc(fmtDate(req.createdAt))}</span>
            ${req.reference ? `<span>Ref: ${esc(req.reference)}</span>` : ''}
          </div>
          <div class="admin-actions">
            <button class="btn btn--primary btn--sm" type="button" data-decide="approve" data-id="${esc(req.id)}">Kubali</button>
            <button class="btn btn--danger btn--sm" type="button" data-decide="reject" data-id="${esc(req.id)}">Kataa</button>
          </div>
        </div>`,
          )
          .join('')
      : emptyRow('Hakuna maombi yanayosubiri.');

    $('#admin-users').innerHTML = data.recentUsers.length
      ? data.recentUsers
          .map(
            (u) => `
        <div class="row">
          <div class="row__main">
            <strong>${esc(u.name)}</strong>
            <span>${esc(u.email)} · ${esc(u.phone)}</span>
          </div>
          <div class="row__side">
            <strong>${esc(tzs(u.balance))}</strong>
            <span class="chip chip--gold">VIP ${u.vipLevel}</span>
          </div>
        </div>`,
          )
          .join('')
      : emptyRow('Hakuna watumiaji bado.');
  }

  async function decideRequest(id, action) {
    try {
      await api(`/admin/transactions/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { action } });
      toast(action === 'approve' ? 'Ombi limekubaliwa.' : 'Ombi limekataliwa.', 'ok');
      await refresh();
      await loadAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function handlePasswordChange(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api('/account/password', {
        method: 'POST',
        body: {
          currentPassword: form.currentPassword.value,
          newPassword: form.newPassword.value,
        },
      });
      form.reset();
      clearSession();
      showAuth();
      switchAuthTab('login');
      toast('Neno la siri limebadilishwa. Ingia tena.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* ---------------- Forms and events ---------------- */
  function fillMethodSelects() {
    const config = app.config;
    if (!config) return;
    const depositSelect = $('#deposit-method');
    const withdrawSelect = $('#withdraw-method');
    depositSelect.innerHTML = config.depositMethods
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
      .join('');
    withdrawSelect.innerHTML = config.withdrawMethods
      .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
      .join('');
    updateDepositAccount();
    depositSelect.addEventListener('change', updateDepositAccount);
  }

  function updateDepositAccount() {
    const selected = $('#deposit-method').value;
    const method = (app.config ? app.config.depositMethods : []).find((m) => m.id === selected);
    if (method) $('#deposit-account').textContent = method.account;
  }

  function bindEvents() {
    document.addEventListener('click', async (event) => {
      const authTab = event.target.closest('[data-auth-tab]');
      if (authTab) {
        switchAuthTab(authTab.dataset.authTab);
        return;
      }
      const go = event.target.closest('[data-go]');
      if (go) {
        switchView(go.dataset.go);
        return;
      }
      const amountBtn = event.target.closest('[data-amount]');
      if (amountBtn) {
        const chips = amountBtn.closest('.amount-chips');
        const form = document.getElementById(chips.dataset.target);
        if (form && form[chips.dataset.field]) form[chips.dataset.field].value = amountBtn.dataset.amount;
        return;
      }
      const filter = event.target.closest('[data-filter]');
      if (filter) {
        app.filter = filter.dataset.filter;
        renderHistory();
        return;
      }
      const investBtn = event.target.closest('[data-invest]');
      if (investBtn) {
        openInvestDialog(investBtn.dataset.invest);
        return;
      }
      const decide = event.target.closest('[data-decide]');
      if (decide) {
        decide.disabled = true;
        await decideRequest(decide.dataset.id, decide.dataset.decide);
        decide.disabled = false;
        return;
      }
      const action = event.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'logout') await handleLogout();
      if (action.dataset.action === 'copy-invite') {
        const value = $('#invite-link').value;
        try {
          await navigator.clipboard.writeText(value);
          toast('Kiungo kimenakiliwa. Shiriki na rafiki!', 'ok');
        } catch {
          $('#invite-link').select();
          toast('Bonyeza Ctrl+C kunakili kiungo.', 'error');
        }
      }
      if (action.dataset.action === 'dialog-cancel') $('#dialog').close();
    });

    $('#login-form').addEventListener('submit', handleLogin);
    $('#register-form').addEventListener('submit', handleRegister);
    $('#deposit-form').addEventListener('submit', handleDeposit);
    $('#withdraw-form').addEventListener('submit', handleWithdraw);
    $('#password-form').addEventListener('submit', handlePasswordChange);

    $('#dialog-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!app.dialogSubmit) {
        $('#dialog').close();
        return;
      }
      const button = $('#dialog-confirm');
      button.disabled = true;
      try {
        await app.dialogSubmit();
        $('#dialog').close();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        button.disabled = false;
        app.dialogSubmit = null;
      }
    });
  }

  async function boot() {
    bindEvents();
    try {
      app.config = await api('/config', { auth: false });
      app.packages = app.config.packages || [];
      fillMethodSelects();
    } catch {
      /* config itajaribiwa tena baada ya kuingia */
    }

    const params = new URLSearchParams(location.search);
    const ref = params.get('ref');
    if (ref) {
      switchAuthTab('register');
      const input = $('#register-form [name=inviteCode]');
      if (input) input.value = ref.trim().toUpperCase();
    }

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      showAuth();
      return;
    }
    try {
      await loadAll();
      showApp();
    } catch {
      clearSession();
      showAuth();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
