'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'auth_token.txt');

// Generate a persistent token on first boot, printed to console
function getOrCreateToken() {
  if (process.env.SENECA_TOKEN) return process.env.SENECA_TOKEN;
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const token = 'sk-seneca-' + crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  return token;
}

const AUTH_TOKEN = getOrCreateToken();
let authEnabled = true;

function printAuthBanner() {
  const isLocal = process.env.SENECA_NO_AUTH === '1' || process.env.NODE_ENV === 'development';
  if (isLocal) {
    authEnabled = false;
    console.log('┌─────────────────────────────────────────────────┐');
    console.log('│  ⚠️  Auth DISABLED (SENECA_NO_AUTH=1)           │');
    console.log('│  Do NOT expose this to the internet             │');
    console.log('└─────────────────────────────────────────────────┘');
    return;
  }
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│  🔐  Auth ENABLED                               │');
  console.log(`│  Token: ${AUTH_TOKEN.slice(0, 20)}...              │`);
  console.log('│  Set in: Settings → API Token, or SENECA_TOKEN  │');
  console.log('│  Disable: SENECA_NO_AUTH=1 (localhost only)     │');
  console.log('└─────────────────────────────────────────────────┘');
}

// Middleware: validate Bearer token or x-seneca-token header or cookie
function authMiddleware(req, res, next) {
  if (!authEnabled) return next();

  // Allow health check without auth
  if (req.path === '/api/health' || req.path === '/api/auth/status') return next();

  // Static files — no auth needed (the HTML/JS itself)
  if (!req.path.startsWith('/api/')) return next();

  const bearer = req.headers['authorization']?.replace('Bearer ', '');
  const header = req.headers['x-seneca-token'];
  const cookie = req.cookies?.seneca_token;
  const provided = bearer || header || cookie;

  if (!provided) return res.status(401).json({ error: 'UNAUTHORIZED', hint: 'Provide token via Authorization: Bearer <token> or x-seneca-token header' });
  if (!crypto.timingSafeEqual(Buffer.from(provided.padEnd(100)), Buffer.from(AUTH_TOKEN.padEnd(100)))) {
    return res.status(403).json({ error: 'FORBIDDEN', hint: 'Invalid token' });
  }
  next();
}

module.exports = { authMiddleware, printAuthBanner, AUTH_TOKEN, isEnabled: () => authEnabled };
