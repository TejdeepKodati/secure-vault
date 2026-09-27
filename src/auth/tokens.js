import crypto from 'node:crypto';

/**
 * HS256 session tokens.
 *
 * Emits and verifies standard compact JWTs, so the wire format is identical to
 * what the `jsonwebtoken` package would produce for the same key - the token can
 * be pasted into any JWT debugger and swapping the library back in needs no
 * client change.
 *
 * Only HS256 is accepted. The `alg` field of an incoming token is never used to
 * choose the algorithm, which is the flaw behind the classic "alg: none" and
 * RS256-to-HS256 confusion attacks.
 */
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest();

export function signToken(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const encodedBody = Buffer.from(JSON.stringify(body)).toString('base64url');
  const data = `${HEADER}.${encodedBody}`;
  return `${data}.${sign(data, secret).toString('base64url')}`;
}

/** Returns the payload, or null for any malformed, mis-signed or expired token. */
export function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, encodedSignature] = parts;

  let header;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) return null;

  const expected = sign(`${encodedHeader}.${encodedBody}`, secret);
  let provided;
  try {
    provided = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return null;

  return payload;
}
