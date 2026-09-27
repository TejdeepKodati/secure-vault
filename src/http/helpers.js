import { config } from '../config.js';
import { badRequest, payloadTooLarge } from '../util/errors.js';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Strict'}`);
  return parts.join('; ');
}

/**
 * Client address used for login throttling. X-Forwarded-For is only honoured
 * when TRUST_PROXY is set: trusting it unconditionally would let any client
 * forge a fresh identity per attempt and walk straight through the rate limiter.
 *
 * Even behind a proxy the LEFT end of the header is attacker-controlled: a
 * proxy appends the address it saw to whatever the client already sent. Only the
 * entries added by proxies we trust are reliable, and those are at the RIGHT
 * end. With `hops` trusted proxies the real client is the `hops`-th entry from
 * the right. If the header is shorter than that (or absent) the request did not
 * come through the proxy chain we expect, so the socket address is used.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      const picked = chain[chain.length - config.trustProxyHops];
      if (picked) return picked;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/** Attach the request/response conveniences the route modules expect. */
export function decorate(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    url = new URL('http://localhost/');
  }
  req.path = url.pathname;
  req.query = Object.fromEntries(url.searchParams.entries());
  req.cookies = parseCookies(req.headers.cookie);
  req.ip = clientIp(req);
  req.params = {};

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (name, value) => {
    if (!res.headersSent) res.setHeader(name, value);
    return res;
  };
  res.cookie = (name, value, options) => res.set('Set-Cookie', serializeCookie(name, value, options));
  res.json = (body) => {
    const text = JSON.stringify(body);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Length', Buffer.byteLength(text));
    if (req.method === 'HEAD') return res.end();
    return res.end(text);
  };
  res.send = (body) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.set('Content-Length', buffer.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(buffer);
  };
  res.noContent = () => {
    res.statusCode = 204;
    return res.end();
  };
}

/**
 * Buffer and parse a JSON request body, refusing anything over
 * `config.maxJsonBodyBytes`. Multipart uploads never reach this - they are
 * streamed by the multipart parser instead.
 */
export function jsonBody(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    req.body = {};
    return next();
  }
  const type = String(req.headers['content-type'] || '');
  if (type.startsWith('multipart/form-data')) {
    req.body = {};
    return next();
  }
  if (!type.startsWith('application/json') && !type.startsWith('application/x-www-form-urlencoded')) {
    // No parseable body; routes validate what they need and answer 400.
    req.body = {};
    req.resume();
    return next();
  }

  const declared = Number.parseInt(req.headers['content-length'] || '', 10);
  if (Number.isFinite(declared) && declared > config.maxJsonBodyBytes) {
    return next(payloadTooLarge('That request body is too large.'));
  }

  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > config.maxJsonBodyBytes) {
      aborted = true;
      req.destroy();
      next(payloadTooLarge('That request body is too large.'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', (err) => {
    if (!aborted) {
      aborted = true;
      next(badRequest('The request could not be read.', err.message));
    }
  });
  req.on('end', () => {
    if (aborted) return;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) {
      req.body = {};
      return next();
    }
    try {
      if (type.startsWith('application/json')) {
        const parsed = JSON.parse(text);
        req.body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } else {
        req.body = Object.fromEntries(new URLSearchParams(text).entries());
      }
      next();
    } catch (err) {
      next(badRequest('The request body was not valid JSON.', err.message));
    }
  });
}
