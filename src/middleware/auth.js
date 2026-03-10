'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const TOKEN_FILE = path.join(DATA_DIR, '.auth_token');

// ── Token management ──────────────────────────────────────────────────────────
function getOrCreateToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  // Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); // owner-read only
  return token;
}

let _token = null;
function getToken() {
  if (!_token) _token = getOrCreateToken();
  return _token;
}

// ── Middleware ────────────────────────────────────────────────────────────────
/**
 * requireAuth - protects sensitive endpoints (exec, secrets, admin)
 * Accepts token via:
 *   - Header: Authorization: Bearer <token>
 *   - Header: X-API-Key: <token>
 *   - Query:  ?token=<token>
 *   - Body:   { _token: "<token>" }
 */
function requireAuth(req, res, next) {
  const token = getToken();

  // Check Authorization header
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const provided = authHeader.slice(7).trim();
    if (timingSafeEqual(provided, token)) return next();
  }

  // Check X-API-Key header
  const apiKey = req.headers['x-api-key'] || '';
  if (apiKey && timingSafeEqual(apiKey, token)) return next();

  // Check query param
  const queryToken = req.query?.token || '';
  if (queryToken && timingSafeEqual(queryToken, token)) return next();

  // Check body
  const bodyToken = req.body?._token || '';
  if (bodyToken && timingSafeEqual(bodyToken, token)) return next();

  return res.status(401).json({ error: 'UNAUTHORIZED', hint: 'Provide token via Authorization: Bearer <token> header, X-API-Key header, ?token= query param, or _token in body. Find your token in data/.auth_token' });
}

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// ── Optional auth (for endpoints that work unauthed but show more with auth) ──
function optionalAuth(req, res, next) {
  const token = getToken();
  const authHeader = req.headers['authorization'] || '';
  const apiKey = req.headers['x-api-key'] || '';
  const queryToken = req.query?.token || '';
  const bodyToken = req.body?._token || '';

  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : apiKey || queryToken || bodyToken;
  req.authenticated = !!(provided && timingSafeEqual(provided, token));
  next();
}

module.exports = { requireAuth, optionalAuth, getToken };
