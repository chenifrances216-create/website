'use strict';

// Business rules (all amounts in TZS unless stated otherwise)
const MIN_DEPOSIT = 5000;
const MIN_WITHDRAW = 3000;
const MAX_AMOUNT = 50000000;
const SIGNUP_BONUS = 1000;

// Withdrawals: Monday-Friday, 10:00-17:00 East Africa Time (UTC+3)
const TZ_OFFSET_MINUTES = 180;
const TZ_LABEL = 'EAT (UTC+3)';
const WITHDRAW_OPEN_MINUTE = 10 * 60; // 10:00
const WITHDRAW_CLOSE_MINUTE = 17 * 60; // 17:00
const WITHDRAW_FEE_RATE = 0.1; // 10% fee on every withdrawal
const WITHDRAW_DAYS = [1, 2, 3, 4, 5]; // Mon-Fri

// Profit rules: first payout 24h after renting a ship, business days only
const PROFIT_DELAY_HOURS = 24;
const PROFIT_WEEKEND_PAUSE = true;

// Referral: 10% of the invited member's first deposit, credited automatically
const REFERRAL_RATE = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_DAYS = 7;
const INVEST_DAYS = 30;

// Level table: capital -> profit per business day
const LEVELS = [
  [10000, 500],
  [20000, 1000],
  [30000, 1500],
  [60000, 2000],
  [100000, 3000],
  [200000, 5000],
  [300000, 7000],
  [400000, 8000],
  [600000, 15000],
  [700000, 20000],
  [800000, 25000],
  [900000, 30000],
  [1000000, 37000],
];

const SHIP_NAMES = [
  'MV Bahari Star',
  'MV Coral Runner',
  'MV Tembo Express',
  'MV Zanzibar Trader',
  'MV Kilimanjaro Cargo',
  'MV Indian Ocean King',
  'MV Tanga Voyager',
  'MV Pemba Horizon',
  'MV Dar Container',
  'MV Serengeti Bulk',
  'MV Mafia Tanker',
  'MV Nautilus Prime',
  'MV Golden Fleet',
];

const SHIP_TAGS = [
  'Starter',
  'Rising',
  'Popular',
  'Steady',
  'Trusted',
  'Ocean class',
  'Voyager',
  'Horizon',
  'Container',
  'Bulk',
  'Tanker',
  'Premium',
  'Flagship',
];

function tzs(amount) {
  return Number(amount || 0).toLocaleString('en-US');
}

const PACKAGES = LEVELS.map(([capital, dailyProfit], index) => {
  const level = index + 1;
  return {
    id: `ship${level}`,
    name: `Level ${level}`,
    level,
    shipName: SHIP_NAMES[index],
    image: `/img/ships/level-${level}.svg`,
    min: capital,
    max: capital,
    capital,
    dailyProfit,
    dailyRate: Number((dailyProfit / capital).toFixed(4)),
    days: INVEST_DAYS,
    tag: SHIP_TAGS[index] || null,
    perks: [
      `TZS ${tzs(dailyProfit)} profit every business day`,
      `TZS ${tzs(capital)} capital locked for the rental`,
      `First payout 24h after renting · ${INVEST_DAYS} profit days`,
    ],
  };
});

const DEPOSIT_METHODS = [
  { id: 'M-Pesa', label: 'M-Pesa', account: '150 456 789', holder: 'SHIP TRANSFER LTD' },
  { id: 'Tigo Pesa', label: 'Mixx by Yas (Tigo Pesa)', account: '150 456 790', holder: 'SHIP TRANSFER LTD' },
  { id: 'Airtel Money', label: 'Airtel Money', account: '150 456 791', holder: 'SHIP TRANSFER LTD' },
  { id: 'Halopesa', label: 'HaloPesa', account: '150 456 792', holder: 'SHIP TRANSFER LTD' },
  { id: 'Benki', label: 'Bank transfer (CRDB / NMB)', account: '0150 4567 8900', holder: 'SHIP TRANSFER LTD' },
];

const WITHDRAW_OPTIONS = [
  { id: 'M-Pesa', label: 'M-Pesa' },
  { id: 'Tigo Pesa', label: 'Mixx by Yas (Tigo Pesa)' },
  { id: 'Airtel Money', label: 'Airtel Money' },
  { id: 'Halopesa', label: 'HaloPesa' },
  { id: 'Benki', label: 'Bank transfer (CRDB / NMB)' },
];

const WITHDRAW_METHODS = WITHDRAW_OPTIONS.map((m) => m.id);

const TXN_LABELS = {
  deposit: 'Deposit',
  withdraw: 'Withdrawal',
  invest: 'Ship rental',
  profit: 'Daily profit',
  signup_bonus: 'Welcome bonus',
  invite_bonus: 'Referral bonus',
  admin_credit: 'Balance added by admin',
  admin_debit: 'Balance reduced by admin',
};

const RULES = {
  minWithdraw: MIN_WITHDRAW,
  withdrawFeeRate: WITHDRAW_FEE_RATE,
  withdrawDays: 'Monday - Friday',
  withdrawOpen: '10:00',
  withdrawClose: '17:00',
  timezone: TZ_LABEL,
  profitDelayHours: PROFIT_DELAY_HOURS,
  profitWeekends: false,
  referralRate: REFERRAL_RATE,
  capitalWithdrawable: false,
};

module.exports = {
  MIN_DEPOSIT,
  MIN_WITHDRAW,
  MAX_AMOUNT,
  SIGNUP_BONUS,
  TZ_OFFSET_MINUTES,
  TZ_LABEL,
  WITHDRAW_OPEN_MINUTE,
  WITHDRAW_CLOSE_MINUTE,
  WITHDRAW_FEE_RATE,
  WITHDRAW_DAYS,
  PROFIT_DELAY_HOURS,
  PROFIT_WEEKEND_PAUSE,
  REFERRAL_RATE,
  DAY_MS,
  HOUR_MS,
  SESSION_DAYS,
  INVEST_DAYS,
  LEVELS,
  PACKAGES,
  DEPOSIT_METHODS,
  WITHDRAW_OPTIONS,
  WITHDRAW_METHODS,
  TXN_LABELS,
  RULES,
};
