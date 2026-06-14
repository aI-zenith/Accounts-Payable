import crypto from 'node:crypto';

// Password hashing with scrypt (no external dependency). Stored format is a
// single string: scrypt$<saltHex>$<hashHex>. Verification is constant-time.

const KEYLEN = 64;

export function hashPassword(plain) {
  if (!plain || String(plain).length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(plain), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// A URL-safe random token used for invite links and session ids.
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
