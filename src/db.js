'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function emptyState() {
  return {
    users: [],
    sessions: [],
    transactions: [],
    investments: [],
    meta: { createdAt: new Date().toISOString() },
  };
}

let state = null;

function load() {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    state = { ...emptyState(), ...parsed };
    for (const key of ['users', 'sessions', 'transactions', 'investments']) {
      if (!Array.isArray(state[key])) state[key] = [];
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[db] hazikuweza kusoma hifadhi, tunaanza upya:', err.message);
    }
    state = emptyState();
  }
  return state;
}

function getState() {
  return load();
}

function commit() {
  if (!state) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[db] imeshindwa kuhifadhi:', err.message);
  }
}

function reset() {
  state = emptyState();
  commit();
  return state;
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { getState, commit, reset, newId, DATA_DIR, DB_FILE };
