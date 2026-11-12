'use strict';

/*
 * Reversible password storage for the admin panel.
 * Member passwords stay scrypt-hashed for login; a sealed (AES-256-GCM) copy
 * lets the admin reveal them. The key comes from ADMIN_SECRET or a generated
 * file inside DATA_DIR, so it never ships in the source code.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';
let cachedKey = null;

function secretFile() {
  return path.join(db.DATA_DIR, 'admin-secret');
}

function masterSecret() {
  const fromEnv = String(process.env.ADMIN_SECRET || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const found = fs.readFileSync(secretFile(), 'utf8').trim();
    if (found) return found;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[seal] could not read the key file:', err.message);
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(db.DATA_DIR, { recursive: true });
    fs.writeFileSync(secretFile(), generated, { mode: 0o600 });
  } catch (err) {
    console.warn('[seal] could not save the key file:', err.message);
  }
  return generated;
}

function key() {
  if (!cachedKey) cachedKey = crypto.scryptSync(masterSecret(), 'ship-transfer-admin-seal-v1', 32);
  return cachedKey;
}

function seal(plain) {
  const text = String(plain == null ? '' : plain);
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('$');
}

function unseal(sealed) {
  const raw = String(sealed || '');
  if (!raw) return null;
  const parts = raw.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return plain || null;
  } catch (err) {
    return null;
  }
}

module.exports = { seal, unseal };
