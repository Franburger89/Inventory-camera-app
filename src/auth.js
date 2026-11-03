import crypto from 'node:crypto';

const COOKIE = 'stocktake';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function signStaffCookie(pin, now = Date.now()) {
  const exp = now + MAX_AGE_SECONDS * 1000;
  const payload = `v1.${exp}`;
  const sig = crypto.createHmac('sha256', pin).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyStaffCookie(pin, token, now = Date.now()) {
  if (!pin || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [version, exp, sig] = parts;
  if (version !== 'v1') return false;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || now > expires) return false;
  const payload = `${version}.${exp}`;
  const expected = crypto.createHmac('sha256', pin).update(payload).digest('base64url');
  return safeEqual(sig, expected);
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

export function staffCookieHeader(token, { secure = false, maxAge = MAX_AGE_SECONDS } = {}) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function requestIsSecure(req) {
  return Boolean(req.secure) || req.headers['x-forwarded-proto'] === 'https';
}

export function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : '';
}
