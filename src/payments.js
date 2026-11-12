'use strict';

const crypto = require('crypto');

// Mtoa huduma: Flutterwave (Tanzania mobile money)
// Nyaraka: https://developer.flutterwave.com/docs/tanzania
const API_BASE = () => String(process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3').replace(/\/+$/, '');
const SECRET_KEY = () => String(process.env.FLW_SECRET_KEY || '').trim();
const WEBHOOK_HASH = () => String(process.env.FLW_WEBHOOK_HASH || '').trim();
const REQUEST_TIMEOUT_MS = 20000;

// Njia za malipo ya simu -> mtandao wa mtoa huduma
const NETWORKS = {
  'M-Pesa': 'VODACOM',
  'Tigo Pesa': 'TIGO',
  'Airtel Money': 'AIRTEL',
  Halopesa: 'HALOTEL',
};

const MOBILE_METHODS = Object.keys(NETWORKS);

class PaymentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function isLive() {
  return Boolean(SECRET_KEY());
}

function mode() {
  return isLive() ? 'live' : 'sandbox';
}

function networkFor(method) {
  return NETWORKS[String(method || '').trim()] || null;
}

function isMobileMethod(method) {
  return Boolean(networkFor(method));
}

// +255712345678 -> 0712345678 (mtoa huduma anatarajia namba ya ndani)
function localPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const international = digits.match(/^255(\d{9})$/);
  if (international) return `0${international[1]}`;
  if (/^0\d{9}$/.test(digits)) return digits;
  if (/^\d{9}$/.test(digits)) return `0${digits}`;
  return '';
}

function buildChargePayload({ amount, currency = 'TZS', email, phone, method, txRef, name }) {
  const network = networkFor(method);
  if (!network) throw new PaymentError('Njia hii haitumii malipo ya simu', 400);
  const phoneNumber = localPhone(phone);
  if (!phoneNumber) throw new PaymentError('Namba ya simu si sahihi', 400);
  if (!txRef) throw new PaymentError('Kumbukumbu ya muamala haipo', 400);
  return {
    tx_ref: String(txRef),
    amount: String(amount),
    currency,
    email: String(email || ''),
    phone_number: phoneNumber,
    network,
    fullname: String(name || ''),
    meta: { method: String(method), network },
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request(path, options = {}) {
  try {
    return await fetch(`${API_BASE()}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${SECRET_KEY()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PaymentError('Imeshindwa kuwasiliana na mtoa huduma wa malipo. Jaribu tena.');
  }
}

// Ombi la malipo (USSD push) kwa M-Pesa / Tigo Pesa / Airtel / Halo
async function initiateCharge(input) {
  const payload = buildChargePayload(input);
  if (!isLive()) {
    return {
      provider: 'sandbox',
      providerRef: `SBX-${crypto.randomBytes(8).toString('hex')}`,
      status: 'pending',
      message: 'Hali ya majaribio: hakuna pesa halisi inayotolewa.',
      sandbox: true,
    };
  }

  const response = await request('/charges?type=mobile_money_tanzania', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const body = await readJson(response);
  if (!response.ok || !body || body.status !== 'success' || !body.data) {
    const reason = body && (body.message || (body.data && body.data.message));
    throw new PaymentError(
      String(reason || `Mtoa huduma alikataa ombi (HTTP ${response.status})`).slice(0, 200),
    );
  }

  return {
    provider: 'flutterwave',
    providerRef: String(body.data.id || ''),
    flwRef: body.data.flw_ref ? String(body.data.flw_ref) : null,
    status: String(body.data.status || 'pending'),
    message: String(body.data.processor_response || 'Ombi la malipo limetumwa'),
    sandbox: false,
  };
}

// Uthibitisho wa moja kwa moja kwa mtoa huduma (bila kusubiri webhook)
async function fetchCharge(providerRef) {
  if (!isLive() || !providerRef) return null;
  const response = await request(`/transactions/${encodeURIComponent(providerRef)}/verify`, { method: 'GET' });
  const body = await readJson(response);
  if (!response.ok || !body || !body.data) return null;
  return {
    status: String(body.data.status || ''),
    amount: Number(body.data.amount),
    currency: String(body.data.currency || ''),
    raw: body.data,
  };
}

// Webhook: mtoa huduma hutuma kichwa cha verif-hash kinacholingana na FLW_WEBHOOK_HASH
function verifyWebhook(headerValue) {
  const expected = WEBHOOK_HASH();
  if (!expected) return false;
  const given = Buffer.from(String(headerValue || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(given, want);
  } catch {
    return false;
  }
}

function describe() {
  return {
    mode: mode(),
    live: isLive(),
    provider: isLive() ? 'flutterwave' : 'sandbox',
    mobileMethods: MOBILE_METHODS,
    webhookConfigured: Boolean(WEBHOOK_HASH()),
  };
}

module.exports = {
  MOBILE_METHODS,
  NETWORKS,
  PaymentError,
  buildChargePayload,
  describe,
  fetchCharge,
  initiateCharge,
  isLive,
  isMobileMethod,
  localPhone,
  mode,
  networkFor,
  verifyWebhook,
};
