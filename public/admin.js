'use strict';

/* Ship Transfer — admin panel (separate password, separate session) */

const TOKEN_KEY = 'ship.admin.token';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  overview: null,
  segment: 'all',
  search: '',
  depositFilter: 'all',
  withdrawFilter: 'all',
  selectedId: null,
  revealed: null,
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(amount) {
  const n = Number(amount || 0);
  return `TZS ${n.toLocaleString('en-US')}`;
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(`/api/apanel${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.token}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401) {
    signOutLocal();
    throw new Error(data.error || 'Admin sign-in required');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function signOutLocal() {
  state.token = '';
  state.overview = null;
  localStorage.removeItem(TOKEN_KEY);
  $('#panel').hidden = true;
  $('#login').hidden = false;
  $('#login-password').value = '';
}

// ---------- Kuingia ----------

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('#login-error');
  errorEl.hidden = true;
  const password = $('#login-password').value;
  try {
    const res = await fetch('/api/apanel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not sign in');
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    $('#login').hidden = true;
    $('#panel').hidden = false;
    $('#login-password').value = '';
    await loadAll();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
  signOutLocal();
  toast('Signed out');
});

$('#refresh').addEventListener('click', () => loadAll().then(() => toast('Panel refreshed')));

// ---------- Kupakia ----------

async function loadAll() {
  try {
    const data = await api('/overview');
    state.overview = data;
    renderStats();
    renderMembers();
    renderDetail();
    renderNumbers();
    renderAudit();
    $('#default-warning').hidden = !data.usingDefault;
    await Promise.all([loadRequests('deposit'), loadRequests('withdraw')]);
    renderQueue();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderStats() {
  const s = (state.overview && state.overview.stats) || {};
  const cards = [
    ['Members', s.members || 0, 'total accounts'],
    ['Deposited & renting', s.depositors || 0, 'active members'],
    ['Registered only', s.registeredOnly || 0, 'no deposit yet'],
    ['Pending deposits', s.pendingDeposits || 0, 'waiting approval'],
    ['Pending withdrawals', s.pendingWithdrawals || 0, 'waiting payout'],
    ['Profit balances', money(s.totalBalance), 'all members'],
    ['Locked capital', money(s.totalCapital), 'all members'],
    ['Blocked', s.blocked || 0, 'withdrawals stopped'],
  ];
  $('#stats').innerHTML = cards.map(([label, value, hint]) => `
    <div class="stat">
      <span class="stat-label">${esc(label)}</span>
      <strong class="stat-value">${esc(value)}</strong>
      <span class="stat-hint">${esc(hint)}</span>
    </div>`).join('');
}

function membersFiltered() {
  const all = (state.overview && state.overview.members) || [];
  const needle = state.search.trim();
  return all.filter((m) => {
    if (state.segment === 'active' && m.segment !== 'active') return false;
    if (state.segment === 'registered' && m.segment !== 'registered') return false;
    if (state.segment === 'blocked' && !m.withdrawBlocked) return false;
    if (needle && !String(m.phone).includes(needle) && !String(m.name || '').toLowerCase().includes(needle.toLowerCase())) return false;
    return true;
  });
}

function renderMembers() {
  const rows = membersFiltered();
  if (!rows.length) {
    $('#members-list').innerHTML = '<p class="empty">No members in this group.</p>';
    return;
  }
  $('#members-list').innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Phone</th><th>Group</th><th>Balance</th><th>Capital</th>
            <th>Deposits</th><th>Ships</th><th>Withdrawals</th><th>Joined</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((m) => `
            <tr class="${m.withdrawBlocked ? 'blocked-row' : ''}">
              <td>
                <strong>${esc(m.phone)}</strong>
                ${m.withdrawBlocked ? '<span class="pill bad">blocked</span>' : ''}
              </td>
              <td><span class="pill ${m.segment === 'active' ? 'good' : ''}">${m.segment === 'active' ? 'deposited' : 'registered'}</span></td>
              <td>${esc(money(m.balance))}</td>
              <td>${esc(money(m.capital))}</td>
              <td>${esc(money(m.totalDeposit))}</td>
              <td>${m.activeInvestments}</td>
              <td>${esc(money(m.totalWithdraw))}</td>
              <td class="tiny">${esc(when(m.createdAt))}</td>
              <td><button class="btn small" data-manage="${esc(m.id)}" type="button">Manage</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function currentMember() {
  const all = (state.overview && state.overview.members) || [];
  return all.find((m) => m.id === state.selectedId) || null;
}

function renderDetail() {
  const box = $('#member-detail');
  const m = currentMember();
  if (!m) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(m.phone)}</h2>
        <p class="muted tiny">
          ${m.segment === 'active' ? 'Deposited / renting ships' : 'Registered only, no deposit'} ·
          joined ${esc(when(m.createdAt))} · password ${m.passwordAvailable ? 'stored' : 'not stored'}
        </p>
      </div>
      <button class="btn ghost small" id="detail-close" type="button">Close</button>
    </div>

    <div class="detail-grid">
      <div class="mini">
        <span class="muted tiny">Profit balance</span>
        <strong>${esc(money(m.balance))}</strong>
      </div>
      <div class="mini">
        <span class="muted tiny">Capital (locked)</span>
        <strong>${esc(money(m.capital))}</strong>
      </div>
      <div class="mini">
        <span class="muted tiny">Total deposits</span>
        <strong>${esc(money(m.totalDeposit))}</strong>
      </div>
      <div class="mini">
        <span class="muted tiny">Total withdrawn</span>
        <strong>${esc(money(m.totalWithdraw))}</strong>
      </div>
    </div>

    <div class="detail-blocks">
      <form class="card form-grid" id="balance-form">
        <h3>Add or reduce balance</h3>
        <label>
          Amount (TZS)
          <input name="amount" inputmode="numeric" placeholder="5000" required />
        </label>
        <label>
          Reason (optional)
          <input name="note" placeholder="Manual adjustment" />
        </label>
        <div class="row">
          <button class="btn primary" type="submit" data-action="credit">Add balance</button>
          <button class="btn danger" type="submit" data-action="debit">Reduce balance</button>
        </div>
      </form>

      <div class="card form-grid">
        <h3>Password</h3>
        <div id="password-box" class="password-box">
          ${state.revealed && state.revealed.id === m.id
            ? `<span class="muted tiny">Password</span><strong class="mono">${esc(state.revealed.password)}</strong>`
            : '<span class="muted tiny">Hidden until you reveal it.</span>'}
        </div>
        <div class="row">
          <button class="btn" id="reveal-password" type="button">Show password</button>
        </div>
        <form class="row" id="set-password-form">
          <input name="password" placeholder="New password" minlength="6" />
          <button class="btn ghost" type="submit">Set password</button>
        </form>
      </div>

      <div class="card form-grid">
        <h3>Withdrawals</h3>
        <p class="muted tiny">
          ${m.withdrawBlocked ? `Blocked: ${esc(m.withdrawBlockReason || 'by admin')}` : 'Withdrawals are allowed.'}
        </p>
        <input id="block-reason" placeholder="Reason (optional)" value="${esc(m.withdrawBlockReason || '')}" />
        <div class="row">
          ${m.withdrawBlocked
            ? '<button class="btn primary" id="unblock" type="button">Allow withdrawals</button>'
            : '<button class="btn danger" id="block" type="button">Block withdrawals</button>'}
        </div>
      </div>

      <div class="card form-grid">
        <h3>Delete account</h3>
        <p class="muted tiny">Removes the member, their ships and their history permanently.</p>
        <button class="btn danger" id="delete-member" type="button">Delete this account</button>
        <div id="delete-confirm" hidden>
          <p class="muted tiny">Delete ${esc(m.phone)} permanently? This cannot be undone.</p>
          <div class="row">
            <button class="btn danger" id="delete-confirm-yes" type="button">Yes, delete account</button>
            <button class="btn" id="delete-confirm-no" type="button">Cancel</button>
          </div>
        </div>
      </div>
    </div>`;

  $('#detail-close').addEventListener('click', () => {
    state.selectedId = null;
    state.revealed = null;
    renderDetail();
  });

  $('#balance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const action = event.submitter ? event.submitter.dataset.action : 'credit';
    const amount = Number(form.amount.value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('Enter a valid amount', true);
    try {
      await api(`/members/${m.id}/balance`, { method: 'POST', body: { action, amount, note: form.note.value } });
      toast(`${action === 'credit' ? 'Added' : 'Reduced'} ${money(amount)}`);
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#reveal-password').addEventListener('click', async () => {
    try {
      const data = await api(`/members/${m.id}/password`);
      state.revealed = { id: m.id, password: data.password };
      renderDetail();
      toast('Password revealed');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#set-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await api(`/members/${m.id}/password`, { method: 'POST', body: { password: form.password.value } });
      state.revealed = { id: m.id, password: data.password };
      toast('New password set');
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const blockBtn = $('#block');
  if (blockBtn) {
    blockBtn.addEventListener('click', async () => {
      try {
        await api(`/members/${m.id}/withdraw-block`, {
          method: 'POST',
          body: { blocked: true, reason: $('#block-reason').value },
        });
        toast('Withdrawals blocked');
        await loadAll();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  const unblockBtn = $('#unblock');
  if (unblockBtn) {
    unblockBtn.addEventListener('click', async () => {
      try {
        await api(`/members/${m.id}/withdraw-block`, { method: 'POST', body: { blocked: false } });
        toast('Withdrawals allowed again');
        await loadAll();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  $('#delete-member').addEventListener('click', () => {
    const box = $('#delete-confirm');
    if (box) box.hidden = false;
  });

  const cancelDelete = $('#delete-confirm-no');
  if (cancelDelete) {
    cancelDelete.addEventListener('click', () => {
      const box = $('#delete-confirm');
      if (box) box.hidden = true;
    });
  }

  const confirmDelete = $('#delete-confirm-yes');
  if (confirmDelete) {
    confirmDelete.addEventListener('click', async () => {
      confirmDelete.disabled = true;
      try {
        await api(`/members/${m.id}`, { method: 'DELETE' });
        state.selectedId = null;
        state.revealed = null;
        toast('Account deleted');
        await loadAll();
      } catch (err) {
        confirmDelete.disabled = false;
        toast(err.message, true);
      }
    });
  }
}

// ---------- Deposit / withdraw ----------

async function loadRequests(kind) {
  try {
    const data = await api(`/requests?type=${kind}`);
    if (kind === 'deposit') {
      state.deposits = data;
      renderRequests('deposit');
    } else {
      state.withdrawals = data;
      renderRequests('withdraw');
    }
    renderQueue();
  } catch (err) {
    toast(err.message, true);
  }
}

function pendingRows() {
  const out = [];
  const add = (data, kind) => {
    ((data && data.requests) || []).forEach((r) => {
      if (r.status === 'pending') out.push({ ...r, kind });
    });
  };
  add(state.deposits, 'deposit');
  add(state.withdrawals, 'withdraw');
  out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return out;
}

function renderQueue() {
  const card = $('#queue-card');
  if (!card) return;
  const rows = pendingRows();
  const countEl = $('#queue-count');
  if (countEl) countEl.textContent = rows.length ? `${rows.length} waiting` : '';
  card.hidden = rows.length === 0;
  const listEl = $('#pending-queue');
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = rows.map((r) => `
    <article class="queue-item">
      <div class="queue-main">
        <span class="pill ${r.kind === 'deposit' ? 'good' : 'warn'}">${r.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</span>
        <strong>${esc(money(r.amount))}</strong>
        <span class="muted tiny block">${esc(r.member ? r.member.phone : 'deleted account')} · ${esc(r.method || '—')} · ${esc(when(r.createdAt))}</span>
        ${r.kind === 'withdraw' ? `<span class="muted tiny block">Fee ${esc(money(r.fee))} → pays out ${esc(money(r.net))}</span>` : ''}
      </div>
      <div class="queue-actions">
        <button class="btn primary" data-decide="approve" data-id="${esc(r.id)}" data-kind="${r.kind}" type="button">Approve</button>
        <button class="btn danger" data-decide="reject" data-id="${esc(r.id)}" data-kind="${r.kind}" type="button">Reject</button>
      </div>
    </article>`).join('');
}

function renderRequests(kind) {
  const data = kind === 'deposit' ? state.deposits : state.withdrawals;
  const filter = kind === 'deposit' ? state.depositFilter : state.withdrawFilter;
  const listEl = kind === 'deposit' ? $('#deposits-list') : $('#withdrawals-list');
  if (!data) return;
  const rows = (data.requests || []).filter((r) => filter === 'all' || r.status === filter);
  if (!rows.length) {
    listEl.innerHTML = '<p class="empty">Nothing here yet.</p>';
    return;
  }
  listEl.innerHTML = `
    <p class="muted tiny">${data.total} ${kind === 'deposit' ? 'deposits' : 'withdrawals'} · ${data.pending} pending</p>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Member</th><th>Amount</th><th>${kind === 'withdraw' ? 'Fee / net' : 'Method'}</th>
            <th>Status</th><th>When</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>
                <strong>${esc(r.member ? r.member.phone : 'deleted account')}</strong>
                ${r.member ? `<span class="muted tiny block">${esc(r.member.name || '')}</span>` : ''}
              </td>
              <td>${esc(money(r.amount))}</td>
              <td class="tiny">${kind === 'withdraw' ? `${esc(money(r.fee))} → ${esc(money(r.net))}` : esc(r.method || r.channel || '—')}</td>
              <td><span class="pill ${r.status === 'pending' ? 'warn' : r.status === 'completed' ? 'good' : 'bad'}">${esc(r.status)}</span></td>
              <td class="tiny">${esc(when(r.createdAt))}</td>
              <td class="row tight">
                ${r.status === 'pending' ? `
                  <button class="btn small primary" data-decide="approve" data-id="${esc(r.id)}" data-kind="${kind}" type="button">Approve</button>
                  <button class="btn small danger" data-decide="reject" data-id="${esc(r.id)}" data-kind="${kind}" type="button">Reject</button>
                ` : '<span class="muted tiny">handled</span>'}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

document.addEventListener('click', async (event) => {
  const manage = event.target.closest('[data-manage]');
  if (manage) {
    state.selectedId = manage.dataset.manage;
    state.revealed = null;
    renderDetail();
    $('#member-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const decideBtn = event.target.closest('[data-decide]');
  if (decideBtn) {
    const { decide, id, kind } = decideBtn.dataset;
    const siblings = decideBtn.parentElement ? Array.from(decideBtn.parentElement.querySelectorAll('[data-decide]')) : [];
    decideBtn.disabled = true;
    siblings.forEach((btn) => { btn.disabled = true; });
    try {
      await api(`/requests/${id}/decision`, { method: 'POST', body: { action: decide } });
      toast(`${kind === 'deposit' ? 'Deposit' : 'Withdrawal'} ${decide === 'approve' ? 'approved' : 'rejected'}`);
      await loadAll();
    } catch (err) {
      decideBtn.disabled = false;
      siblings.forEach((btn) => { btn.disabled = false; });
      toast(err.message, true);
    }
  }
});

// ---------- Namba za deposit ----------

function renderNumbers() {
  const list = (state.overview && state.overview.depositNumbers) || [];
  if (!list.length) {
    $('#numbers-list').innerHTML = '<p class="empty">No deposit numbers yet. Members will not see any numbers until you add one.</p>';
    return;
  }
  $('#numbers-list').innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Network</th><th>Number</th><th>Name</th><th>Note</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${list.map((n) => `
            <tr>
              <td>${esc(n.method)}</td>
              <td class="mono">${esc(n.number)}</td>
              <td>${esc(n.name)}</td>
              <td class="tiny">${esc(n.note || '—')}</td>
              <td><span class="pill ${n.active === false ? 'bad' : 'good'}">${n.active === false ? 'hidden' : 'active'}</span></td>
              <td class="row tight">
                <button class="btn small" data-edit-number="${esc(n.id)}" type="button">Edit</button>
                <button class="btn small danger" data-delete-number="${esc(n.id)}" type="button">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $$('[data-edit-number]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const found = list.find((n) => n.id === btn.dataset.editNumber);
      if (!found) return;
      const form = $('#number-form');
      form.id.value = found.id;
      form.method.value = found.method;
      form.number.value = found.number;
      form.name.value = found.name;
      form.note.value = found.note || '';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  $$('[data-delete-number]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cell = btn.closest('td');
      if (!cell) return;
      const id = esc(btn.dataset.deleteNumber);
      cell.innerHTML = `
        <span class="tiny">Delete this number?</span>
        <button class="btn small danger" data-confirm-number="${id}" type="button">Yes, delete</button>
        <button class="btn small" data-cancel-number="1" type="button">Cancel</button>`;

      const yes = cell.querySelector('[data-confirm-number]');
      const no = cell.querySelector('[data-cancel-number]');
      if (no) no.addEventListener('click', () => renderNumbers());
      if (yes) {
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          try {
            await api(`/deposit-numbers/${btn.dataset.deleteNumber}`, { method: 'DELETE' });
            toast('Deposit number deleted');
            await loadAll();
          } catch (err) {
            toast(err.message, true);
            renderNumbers();
          }
        });
      }
    });
  });
}

$('#number-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/deposit-numbers', {
      method: 'POST',
      body: {
        id: form.id.value || undefined,
        method: form.method.value,
        number: form.number.value,
        name: form.name.value,
        note: form.note.value,
      },
    });
    form.reset();
    form.id.value = '';
    toast('Deposit number saved');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#number-reset').addEventListener('click', () => {
  const form = $('#number-form');
  form.reset();
  form.id.value = '';
});

// ---------- Usalama ----------

function renderAudit() {
  const rows = (state.overview && state.overview.audit) || [];
  if (!rows.length) {
    $('#audit-list').innerHTML = '<p class="empty">No activity yet.</p>';
    return;
  }
  $('#audit-list').innerHTML = rows.map((row) => `
    <div class="audit-row">
      <span class="mono tiny">${esc(when(row.at))}</span>
      <strong>${esc(row.action.replace(/_/g, ' '))}</strong>
      <span class="muted tiny">${esc(row.detail || '')}</span>
    </div>`).join('');
}

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/password', {
      method: 'POST',
      body: { current: form.current.value, next: form.next.value },
    });
    form.reset();
    toast('Admin password changed. Sign in again.');
    signOutLocal();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Tabs na vichujio ----------

$('#tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
  ['members', 'deposits', 'withdrawals', 'numbers', 'security'].forEach((name) => {
    const view = $(`#view-${name}`);
    if (view) view.hidden = name !== tab.dataset.tab;
  });
});

$('#quick-number').addEventListener('click', () => {
  const tab = $('[data-tab="numbers"]');
  if (tab) tab.click();
  const form = $('#number-form');
  if (!form) return;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const first = form.querySelector('input[name="method"]');
  if (first) first.focus();
});

$('#segments').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-segment]');
  if (!chip) return;
  state.segment = chip.dataset.segment;
  $$('#segments .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderMembers();
});

$('#search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderMembers();
});

$('#deposit-filter').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-status]');
  if (!chip) return;
  state.depositFilter = chip.dataset.status;
  $$('#deposit-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderRequests('deposit');
});

$('#withdraw-filter').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-status]');
  if (!chip) return;
  state.withdrawFilter = chip.dataset.status;
  $$('#withdraw-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderRequests('withdraw');
});

// ---------- Kuanza ----------

(async function start() {
  if (!state.token) {
    $('#login').hidden = false;
    return;
  }
  $('#login').hidden = true;
  $('#panel').hidden = false;
  try {
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
})();
