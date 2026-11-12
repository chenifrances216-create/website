'use strict';

const crypto = require('crypto');
const db = require('./db');
const { SESSION_DAYS } = require('./constants');

const KEY_LEN = 64;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  let expected;
  try {
    expected = Buffer.from(hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const candidate = crypto.scryptSync(String(password), salt, KEY_LEN);
  return crypto.timingSafeEqual(candidate, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(state, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // Safisha session zilizopitwa na wakati
  state.sessions = state.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
  state.sessions.push({
    id: db.newId(),
    userId,
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_MS).toISOString(),
  });
  return token;
}

function getSession(state, token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = state.sessions.find((s) => s.tokenHash === tokenHash);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const user = state.users.find((u) => u.id === session.userId);
  if (!user) return null;
  return { session, user };
}

function destroySession(state, token) {
  const tokenHash = hashToken(token);
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.tokenHash !== tokenHash);
  return state.sessions.length !== before;
}

function destroyUserSessions(state, userId) {
  state.sessions = state.sessions.filter((s) => s.userId !== userId);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  destroyUserSessions,
};
