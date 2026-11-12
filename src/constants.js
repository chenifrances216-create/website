'use strict';

// Bei na kanuni za mfumo (TZS)
const MIN_DEPOSIT = 5000;
const MIN_WITHDRAW = 10000;
const MAX_AMOUNT = 50000000;
const SIGNUP_BONUS = 1000;
const INVITE_BONUS_INVITER = 2000;
const INVITE_BONUS_INVITEE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_DAYS = 7;

const PACKAGES = [
  {
    id: 'vip1',
    name: 'VIP 1',
    level: 1,
    min: 10000,
    max: 49999,
    dailyRate: 0.015,
    days: 30,
    tag: 'Anza hapa',
    perks: ['Faida ya 1.5% kwa siku', 'Muda wa siku 30', 'Malipo kila siku'],
  },
  {
    id: 'vip2',
    name: 'VIP 2',
    level: 2,
    min: 50000,
    max: 199999,
    dailyRate: 0.02,
    days: 30,
    tag: 'Maarufu',
    perks: ['Faida ya 2.0% kwa siku', 'Muda wa siku 30', 'Msaada wa kipaumbele'],
  },
  {
    id: 'vip3',
    name: 'VIP 3',
    level: 3,
    min: 200000,
    max: 499999,
    dailyRate: 0.025,
    days: 30,
    tag: 'Imara',
    perks: ['Faida ya 2.5% kwa siku', 'Muda wa siku 30', 'Ripoti ya kila wiki'],
  },
  {
    id: 'vip4',
    name: 'VIP 4',
    level: 4,
    min: 500000,
    max: 999999,
    dailyRate: 0.03,
    days: 30,
    tag: 'Premium',
    perks: ['Faida ya 3.0% kwa siku', 'Muda wa siku 30', 'Meneja wa akaunti'],
  },
  {
    id: 'vip5',
    name: 'VIP 5',
    level: 5,
    min: 1000000,
    max: 50000000,
    dailyRate: 0.035,
    days: 30,
    tag: 'Elite',
    perks: ['Faida ya 3.5% kwa siku', 'Muda wa siku 30', 'Utoaji wa haraka'],
  },
];

const DEPOSIT_METHODS = [
  { id: 'M-Pesa', label: 'M-Pesa', account: '150 456 789', holder: 'SHIP TRANSFER LTD' },
  { id: 'Tigo Pesa', label: 'Mixx by Yas (Tigo Pesa)', account: '150 456 790', holder: 'SHIP TRANSFER LTD' },
  { id: 'Airtel Money', label: 'Airtel Money', account: '150 456 791', holder: 'SHIP TRANSFER LTD' },
  { id: 'Halopesa', label: 'HaloPesa', account: '150 456 792', holder: 'SHIP TRANSFER LTD' },
  { id: 'Benki', label: 'Benki (CRDB / NMB)', account: '0150 4567 8900', holder: 'SHIP TRANSFER LTD' },
];

const WITHDRAW_METHODS = ['M-Pesa', 'Tigo Pesa', 'Airtel Money', 'Halopesa', 'Benki'];

const TXN_LABELS = {
  deposit: 'Amana',
  withdraw: 'Utoaji',
  invest: 'Uwekezaji',
  profit: 'Faida',
  signup_bonus: 'Bonasi ya usajili',
  invite_bonus: 'Bonasi ya mwaliko',
};

module.exports = {
  MIN_DEPOSIT,
  MIN_WITHDRAW,
  MAX_AMOUNT,
  SIGNUP_BONUS,
  INVITE_BONUS_INVITER,
  INVITE_BONUS_INVITEE,
  DAY_MS,
  SESSION_DAYS,
  PACKAGES,
  DEPOSIT_METHODS,
  WITHDRAW_METHODS,
  TXN_LABELS,
};
