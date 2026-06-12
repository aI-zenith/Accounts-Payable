import crypto from 'node:crypto';
import 'dotenv/config';

// AES-256-GCM at-rest encryption for stored secrets.
//
// The key comes from APP_ENCRYPTION_KEY, a base64-encoded 32-byte value:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Stored format is a single base64 string holding iv || authTag || ciphertext:
//   [ 12-byte IV ][ 16-byte GCM tag ][ ciphertext ]
// This keeps everything the decrypt step needs in one column value.

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). It should be base64 of 32 random bytes.`
    );
  }
  return key;
}

export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decrypt(payload) {
  if (payload == null) return null;
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Encrypted payload is too short or corrupt.');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// Render a secret for display without revealing it: keep only the last 4 chars.
export function mask(plaintext, opts = {}) {
  if (!plaintext) return '';
  const prefix = opts.prefix ?? '';
  const tail = String(plaintext).slice(-4);
  return `${prefix}…${tail}`;
}
