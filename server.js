'use strict';
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const { exec, execSync } = require('child_process');
const fetch      = require('node-fetch');

// ── Core modules ──────────────────────────────────────────────────────────────
const db   = require('./src/db/index');
const u    = require('./src/utils/index');
const { buildSystemPrompt } = require('./src/utils/systemPrompt');
const { requireAuth, getToken } = require('./src/middleware/auth');

// ── Route modules ─────────────────────────────────────────────────────────────
const costsRouter         = require('./src/routes/costs');
const runsRouter          = require('./src/routes/runs');
const kanbanRouter        = require('./src/routes/kanban');
const observabilityRouter = require('./src/routes/observability');
const convExtrasRouter    = require('./src/routes/conversation-extras');
const extrasRouter        = require('./src/routes/extras');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Optional deps ─────────────────────────────────────────────────────────────
let helmet, rateLimit;
try { helmet = require('helmet'); } catch { helmet = null; }
try { rateLimit = require('express-rate-limit'); } catch { rateLimit = null; }

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
if (helmet) app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '400mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => { req.traceId = crypto.randomBytes(6).toString('hex'); next(); });

// Request tracing
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    try { db.addRequestTrace({ method: req.method, path: req.path, statusCode: res.statusCode, latencyMs: Date.now()-start, ip: req.ip||'', userAgent: req.get('user-agent')||'' }); } catch(_) {}
  });
  next();
});

// ── Rate limiters ─────────────────────────────────────────────────────────────
const rl = (max, windowMs = 60000) => {
  if (!rateLimit) return (_r, _s, n) => n();
  return rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'RATE_LIMIT' }) });
};
const heavyLimiter = rl(20);
const chatLimiter  = rl(120);
const execLimiter  = rl(120);

// ── Circuit breaker ───────────────────────────────────────────────────────────
class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name = name;
    this.threshold = opts.threshold || 4;
    this.resetTimeout = opts.resetTimeout || 20000;
    this.state = 'closed'; this.failures = 0; this.lastFailure = null; this.successCount = 0;
  }
  canExecute() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeout) { this.state = 'half-open'; return true; }
      return false;
    }
    return true;
  }
  onSuccess() { this.failures = 0; if (this.state === 'half-open') { this.successCount++; if (this.successCount >= 2) { this.state = 'closed'; this.successCount = 0; } } }
  onFailure() { this.failures++; this.lastFailure = Date.now(); this.successCount = 0; if (this.state === 'half-open' || this.failures >= this.threshold) this.state = 'open'; }
  status() { return { state: this.state, failures: this.failures, lastFailure: this.lastFailure }; }
}
const ollamaBreaker = new CircuitBreaker('ollama');

// ── Retry with exponential backoff ────────────────────────────────────────────
async function withRetry(fn, opts = {}) {
  const { maxRetries = 3, baseDelay = 500, maxDelay = 8000, shouldRetry } = opts;
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) { const d = Math.min(baseDelay * Math.pow(2, i-1), maxDelay); await new Promise(r => setTimeout(r, d + Math.random() * d * 0.3)); }
    try { return await fn(i); } catch(e) { lastErr = e; if (e.name === 'AbortError') break; if (shouldRetry && !shouldRetry(e, i)) break; }
  }
  throw lastErr;
}

const activeStreams = new Map();

// ── Tool output cache (1-min TTL, LRU at 200 entries) ─────────────────────────
const toolCache = new Map();
function getCachedTool(cmd) {
  const k = crypto.createHash('md5').update(cmd.trim()).digest('hex');
  const e = toolCache.get(k);
  return (e && Date.now() - e.ts < 60000) ? e.output : null;
}
function setCachedTool(cmd, output) {
  const k = crypto.createHash('md5').update(cmd.trim()).digest('hex');
  toolCache.set(k, { output, ts: Date.now() });
  if (toolCache.size > 200) { const old = [...toolCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0]; toolCache.delete(old[0]); }
}

// ── Log broadcast (SSE) ───────────────────────────────────────────────────────
const logClients = new Set();
function broadcastLog(msg) {
  if (!logClients.size) return;
  const payload = 'data: ' + JSON.stringify({ msg, ts: Date.now() }) + '\n\n';
  for (const c of logClients) { try { c.write(payload); } catch { logClients.delete(c); } }
}
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { _origLog(...a); broadcastLog(a.map(String).join(' ')); };
console.error = (...a) => { _origErr(...a); broadcastLog('[ERR] ' + a.map(String).join(' ')); };

// ── Compaction snapshots (persisted per-session via DB) ───────────────────────
// Using a simple in-process map for single-turn injection (cleared after use).
const compactionSnapshots = new Map();
const memFlushFired = new Set();

// ── Integration config ────────────────────────────────────────────────────────
function getINT() {
  const s = db.getSecrets();
  return {
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     || s.GOOGLE_CLIENT_ID     || '',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || s.GOOGLE_CLIENT_SECRET || '',
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || s.GOOGLE_REFRESH_TOKEN || '',
    SLACK_BOT_TOKEN:      process.env.SLACK_BOT_TOKEN      || s.SLACK_BOT_TOKEN      || '',
    GITHUB_TOKEN:         process.env.GITHUB_TOKEN         || s.GITHUB_TOKEN         || '',
    NOTION_TOKEN:         process.env.NOTION_TOKEN         || s.NOTION_TOKEN         || '',
    LINEAR_API_KEY:       process.env.LINEAR_API_KEY       || s.LINEAR_API_KEY       || '',
    BRAVE_API_KEY:        process.env.BRAVE_API_KEY        || s.BRAVE_API_KEY        || '',
    SEARXNG_URL:          process.env.SEARXNG_URL          || s.SEARXNG_URL          || 'http://localhost:8080',
  };
}
function getIntegrationStatus() {
  const INT = getINT();
  return {
    google:  { configured: !!(INT.GOOGLE_CLIENT_ID && INT.GOOGLE_REFRESH_TOKEN), fields: ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'] },
    slack:   { configured: !!INT.SLACK_BOT_TOKEN,  fields: ['SLACK_BOT_TOKEN'] },
    github:  { configured: !!INT.GITHUB_TOKEN,     fields: ['GITHUB_TOKEN'] },
    notion:  { configured: !!INT.NOTION_TOKEN,     fields: ['NOTION_TOKEN'] },
    linear:  { configured: !!INT.LINEAR_API_KEY,   fields: ['LINEAR_API_KEY'] },
    brave:   { configured: !!INT.BRAVE_API_KEY,    fields: ['BRAVE_API_KEY'] },
    searxng: { configured: !!INT.SEARXNG_URL,      fields: ['SEARXNG_URL'] },
  };
}

// ── BM25 search ───────────────────────────────────────────────────────────────
let _bm25Cache = null;
function invalidateBm25Cache() { _bm25Cache = null; }
function doSearch(query, topK = 8, hybrid = false) {
  const q = u.rewriteQuery(query);
  const all = db.getAllChunks();
  if (!all.length) return { chunks: [] };
  const qT = u.tokenize(q);
  if (!qT.length) return { chunks: [] };
  const N = all.length;
  if (!_bm25Cache || _bm25Cache.N !== N) {
    const avgLen = all.reduce((s, c) => s + (c.len || 0), 0) / N;
    const df = {};
    for (const c of all) for (const t of Object.keys(c.freq || {})) df[t] = (df[t] || 0) + 1;
    _bm25Cache = { N, avgLen, df };
  }
  const { avgLen, df } = _bm25Cache;
  const scored = all.map(c => {
    const b = u.bm25(qT, c.freq || {}, c.len || 1, avgLen, N, df);
    const s = hybrid ? u.cosineSim(q, c.text) * 2 : 0;
    return { filename: c.filename, relPath: c.rel_path, text: c.text, score: b + s };
  }).filter(c => c.score > 0);
  scored.sort((a,b) => b.score - a.score);
  const seen = new Map(); const result = [];
  for (const r of scored) {
    const cnt = seen.get(r.filename) || 0;
    if (cnt < 3) { result.push(r); seen.set(r.filename, cnt + 1); }
    if (result.length >= topK) break;
  }
  const maxScore = result[0]?.score || 1;
  result.forEach(r => { r.confidence = Math.round((r.score / maxScore) * 100); });
  return { chunks: result, rewrittenQuery: q !== query ? q : undefined };
}

// ── Google OAuth helper ───────────────────────────────────────────────────────
async function getGoogleToken() {
  const INT = getINT();
  if (!INT.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: INT.GOOGLE_CLIENT_ID, client_secret: INT.GOOGLE_CLIENT_SECRET, refresh_token: INT.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google token failed: ' + (d.error_description || d.error || 'unknown'));
  return d.access_token;
}

// =============================================================================
// ROUTES
// =============================================================================

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/api/secrets', requireAuth, (_,res) => { const s = db.getSecrets(); const masked = {}; for (const k of Object.keys(s)) masked[k] = s[k] ? '••••' + s[k].slice(-4) : ''; res.json({ ok: true, keys: Object.keys(s), masked }); });
app.post('/api/secrets', requireAuth, (req, res) => { try { for (const [k, v] of Object.entries(req.body || {})) db.setSecret(k, v || null); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/secrets/:key', requireAuth, (req, res) => { try { db.deleteSecret(req.params.key); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/integrations/status', (_, res) => res.json(getIntegrationStatus()));
app.get('/api/auth-token', (req, res) => res.json({ token: getToken() }));
app.get('/api/__init', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('localhost');
  if (!isLocal) return res.status(403).json({ error: 'LOCAL_ONLY' });
  res.json({ token: getToken(), v: '18.1.0' });
});

// ── Conversations ─────────────────────────────────────────────────────────────
app.get('/api/conversations', (_, res) => res.json(db.listConversations()));
app.post('/api/conversations', (req, res) => {
  const { id, name, messages, model } = req.body;
  if (name && !u.validateStr(name, 400)) return res.status(400).json({ error: 'INVALID_NAME' });
  try { const cid = db.upsertConversation({ id: id || crypto.randomUUID(), name, messages, model }); res.json({ ok: true, id: cid }); }
  catch(e) { db.logError('save-convo', e); res.status(500).json({ error: 'SAVE_FAILED' }); }
});
app.get('/api/conversations/search', (req, res) => { const q = (req.query.q || '').toLowerCase().trim(); if (!q) return res.json([]); res.json(db.searchConversations(q)); });
app.get('/api/conversations/:id', (req, res) => { const c = db.getConversation(req.params.id); if (!c) return res.status(404).json({ error: 'NOT_FOUND' }); res.json(c); });
app.delete('/api/conversations/:id', (req, res) => { try { db.deleteConversation(req.params.id); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.patch('/api/conversations/:id', (req, res) => { try { if (!req.body.name) return res.status(400).json({ error: 'name required' }); db.patchConversation(req.params.id, req.body.name); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.get('/api/conversations/:id/export', (req, res) => {
  const fmt = req.query.format || 'md';
  const conv = db.getConversation(req.params.id);
  if (!conv) return res.status(404).send('Not found');
  const safeName = (conv?.name||'chat').replace(/[^a-z0-9]/gi,'_').slice(0,50);
  if (fmt === 'json') { res.setHeader('Content-Type','application/json'); res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.json"'); return res.send(JSON.stringify({ id: conv.id, name: conv.name, model: conv.model, messages: conv.messages, exportedAt: new Date().toISOString() }, null, 2)); }
  if (fmt === 'html') {
    const msgs = (conv.messages||[]).map(m => { const role = m.role === 'user' ? '🧑 You' : '🤖 Assistant'; const content = String(m.content||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); return `<div class="msg ${m.role}"><div class="role">${role}</div><div class="content">${content}</div></div>`; }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${safeName}</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;background:#0a0a0b;color:#e8e8ec}.msg{margin:16px 0;padding:12px 16px;border-radius:8px}.user{background:#1a1a2e}.assistant{background:#111113}.role{font-size:11px;color:#6c8fff;margin-bottom:6px;font-weight:600}.content{line-height:1.6;white-space:pre-wrap}</style></head><body><h1 style="color:#6c8fff;font-size:16px">${(conv.name||'').replace(/</g,'&lt;')}</h1>${msgs}</body></html>`;
    res.setHeader('Content-Type','text/html'); res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.html"'); return res.send(html);
  }
  const md = db.exportConversation(req.params.id);
  if (!md) return res.status(404).send('Not found');
  res.setHeader('Content-Type','text/markdown'); res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.md"'); res.send(md);
});
app.post('/api/conversations/:id/duplicate', (req, res) => { const newId = db.duplicateConversation(req.params.id); if (!newId) return res.status(404).json({ error: 'NOT_FOUND' }); res.json({ ok: true, id: newId }); });
app.post('/api/conversations/bulk-delete', (req, res) => { const { ids = [] } = req.body; db.bulkDeleteConversations(ids); res.json({ ok: true, deleted: ids.length }); });

// ── Memory ────────────────────────────────────────────────────────────────────
app.get('/api/memory', (req, res) => { const ns = req.query.namespace; const q = req.query.q; const topK = parseInt(req.query.topK) || 20; let mem = q ? db.retrieveRelevantMemory(q, topK) : db.loadMemory(ns || null, topK); res.json(mem.slice(0, topK)); });
app.post('/api/memory', (req, res) => { const { namespace = 'project_facts', key, content, confidence = 0.8, expiresIn = null } = req.body; if (!u.validateStr(key || '', 500) || !content) return res.status(400).json({ error: 'INVALID' }); try { const entry = db.storeMemory({ namespace, key, content, confidence, expiresIn }); db.auditLog('memory.store', { namespace, key }); res.json({ ok: true, id: entry.id }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/memory/:id', (req, res) => { try { db.getDb().prepare('DELETE FROM memory WHERE id=?').run(req.params.id); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.get('/api/memory/namespaces', (_, res) => { const counts = {}; for (const ns of db.MEMORY_NAMESPACES) counts[ns] = db.getDb().prepare('SELECT COUNT(*) as n FROM memory WHERE namespace=?').get(ns).n; res.json({ namespaces: db.MEMORY_NAMESPACES, counts }); });
app.post('/api/memory/compress', (_, res) => res.json({ ok: true, message: 'SQLite uses UNIQUE(namespace,key) — deduplication is automatic.' }));
app.get('/api/memory/export', (req, res) => { const ns = req.query.namespace; let mem = db.loadMemory(ns || null, 10000); res.setHeader('Content-Type','application/json'); res.setHeader('Content-Disposition', 'attachment; filename="memory_export_' + Date.now() + '.json"'); res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: mem.length, memories: mem }, null, 2)); });
app.post('/api/memory/import', (req, res) => { const { memories = [] } = req.body; let added = 0, skipped = 0; for (const m of memories) { try { db.storeMemory({ namespace: m.namespace, key: m.key, content: m.content, confidence: m.confidence }); added++; } catch { skipped++; } } res.json({ ok: true, added, skipped }); });
app.get('/api/memory/session-summary', (req, res) => { const limit = parseInt(req.query.limit) || 5; const recentEpisodes = db.loadMemory('episodes', limit); const keyFacts = db.getDb().prepare('SELECT * FROM memory WHERE namespace=? AND confidence>0.7 ORDER BY updated_at DESC LIMIT 5').all('project_facts'); const errors = db.loadMemory('past_errors', 3); const prefs = db.getPrefs(); const parts = [keyFacts.length ? 'Key facts: ' + keyFacts.map(m => m.content).join('; ') : null, recentEpisodes.length ? 'Recent: ' + recentEpisodes.map(m => m.content).join('; ') : null, errors.length ? 'Known issues: ' + errors.map(m => m.content).join('; ') : null, prefs.lastDomain ? 'Last domain: ' + prefs.lastDomain : null].filter(Boolean); res.json({ continuityPrompt: parts.join('\n'), facts: keyFacts.length, episodes: recentEpisodes.length, errors: errors.length }); });

// ── Agent memory ──────────────────────────────────────────────────────────────
app.get('/api/agent/memory', (_, res) => res.json(db.getAgentMemory()));
app.post('/api/agent/memory', (req, res) => { const { key, value } = req.body; if (!u.validateStr(key, 200)) return res.status(400).json({ error: 'INVALID_KEY' }); try { db.setAgentMemory(key, value); db.auditLog('memory.set', { key }); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: 'SAVE_FAILED' }); } });
app.delete('/api/agent/memory/:key', (req, res) => { try { db.deleteAgentMemory(req.params.key); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.delete('/api/agent/memory', (_, res) => { try { db.deleteAgentMemory(null); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });

// ── Prefs / Notes / Tasks / Templates / Plans ─────────────────────────────────
app.get('/api/prefs', (_, res) => res.json(db.getPrefs()));
app.post('/api/prefs', (req, res) => { try { db.setPrefs(req.body || {}); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/notes', (_, res) => res.json(db.getNotes()));
app.post('/api/notes', (req, res) => { if (!u.validateStr(req.body.content, 4000)) return res.status(400).json({ error: 'INVALID' }); try { const id = db.addNote({ content: req.body.content, tag: req.body.tag, pinned: req.body.pinned }); res.json({ ok: true, id }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.patch('/api/notes/:id', (req, res) => { try { if (!db.patchNote(req.params.id, req.body)) return res.status(404).json({ error: 'NOT_FOUND' }); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.delete('/api/notes/:id', (req, res) => { try { db.deleteNote(req.params.id); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.delete('/api/notes', (_, res) => { try { db.clearNotes(); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.get('/api/tasks', (_, res) => res.json(db.getTasks()));
app.post('/api/tasks', (req, res) => { if (!u.validateStr(req.body.description, 2000)) return res.status(400).json({ error: 'INVALID' }); try { const id = db.addTask({ description: req.body.description, priority: req.body.priority }); res.json({ ok: true, id }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { db.patchTask(req.params.id, req.body); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.delete('/api/tasks/:id', (req, res) => { try { db.deleteTask(req.params.id); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.get('/api/templates', (_, res) => res.json(db.getTemplates()));
app.post('/api/templates', (req, res) => { if (!u.validateStr(req.body.title, 200) || !u.validateStr(req.body.content, 10000)) return res.status(400).json({ error: 'INVALID' }); const id = db.addTemplate({ title: req.body.title, content: req.body.content, category: req.body.category }); res.json({ ok: true, id }); });
app.delete('/api/templates/:id', (req, res) => { db.deleteTemplate(req.params.id); res.json({ ok: true }); });
app.get('/api/plans', (_, res) => res.json(db.getPlans()));
app.post('/api/plans', (req, res) => { const { task, steps = [] } = req.body; if (!u.validateStr(task || '', 2000)) return res.status(400).json({ error: 'INVALID' }); try { const plan = u.createPlan(task, steps); db.upsertPlan(plan); db.auditLog('plan.created', { id: plan.id }); res.json({ ok: true, plan }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.patch('/api/plans/:id/step', (req, res) => { try { const plan = db.getPlan(req.params.id); if (!plan) return res.status(404).json({ error: 'NOT_FOUND' }); const { stepId, status, result } = req.body; const step = plan.steps.find(s => s.id === stepId); if (step) { step.status = status || step.status; if (result !== undefined) step.result = result; if (status === 'running') step.startedAt = Date.now(); if (status === 'done' || status === 'failed') step.completedAt = Date.now(); } if (plan.steps.every(s => s.status === 'done')) plan.status = 'completed'; db.upsertPlan(plan); res.json({ ok: true, plan }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/plans/:id', (req, res) => { try { db.deletePlan(req.params.id); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });

// ── Metrics / Audit ───────────────────────────────────────────────────────────
app.get('/api/metrics', (req, res) => res.json(db.getMetrics(req.query.type, parseInt(req.query.last) || 100)));
app.get('/api/metrics/summary', (_, res) => res.json(db.getMetricsSummary()));
app.get('/api/audit', (_, res) => res.json({ entries: db.getAuditLog(200) }));
app.post('/api/feedback', (req, res) => { const { messageId, sessionId, rating, comment = '' } = req.body; if (!['up','down'].includes(rating)) return res.status(400).json({ error: 'invalid rating' }); db.addFeedback({ messageId, sessionId, rating, comment }); db.recordMetric('user_satisfaction', rating === 'up' ? 100 : 0, { messageId }); res.json({ ok: true }); });
app.get('/api/feedback', (req, res) => res.json(db.getFeedback(parseInt(req.query.last) || 50)));
app.post('/api/revisions', (req, res) => { const { artifactId, content, type = 'code', sessionId = '' } = req.body; if (!u.validateStr(content || '', 100000)) return res.status(400).json({ error: 'INVALID' }); try { const r = db.addRevision({ artifactId, content, type, sessionId }); res.json({ ok: true, ...r }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/revisions/:artifactId', (req, res) => res.json(db.getRevisions(req.params.artifactId)));

// ── Approvals ─────────────────────────────────────────────────────────────────
app.get('/api/approvals', (_, res) => res.json(db.getApprovals()));
app.post('/api/approvals', (req, res) => { const { action, description, payload, sessionId = '', riskLevel = 'medium' } = req.body; if (!u.validateStr(action || '', 500)) return res.status(400).json({ error: 'INVALID' }); try { const id = crypto.randomUUID(); db.addApproval({ id, action, description, payload, sessionId, riskLevel }); db.auditLog('approval.requested', { action: action.slice(0,100), riskLevel }); const a = db.getApproval(id); res.json({ ok: true, approvalId: id, expiresAt: a.expires_at }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.patch('/api/approvals/:id', (req, res) => { const { status } = req.body; if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' }); const approval = db.getApproval(req.params.id); if (!approval) return res.status(404).json({ error: 'NOT_FOUND' }); if (Date.now() > approval.expires_at) return res.status(410).json({ error: 'APPROVAL_EXPIRED' }); db.resolveApproval(req.params.id, status); db.auditLog('approval.resolved', { id: req.params.id, status }); res.json({ ok: true }); });
app.get('/api/approvals/:id/status', (req, res) => { const a = db.getApproval(req.params.id); if (!a) return res.status(404).json({ error: 'NOT_FOUND' }); res.json({ ...a, expired: Date.now() > a.expires_at && a.status === 'pending' }); });

// ── Exec — UNIFIED endpoint ───────────────────────────────────────────────────
// Replaces the original /exec, /exec/smart, /exec/parallel (which were 95% identical).
// Options: { command, sessionId, cwd, bypassCache, stream }
// Safety pipeline: validate → loop-detect → safety-score → audit → execute
app.post('/api/exec', requireAuth, execLimiter, (req, res) => {
  const { command, sessionId = '', cwd: reqCwd, bypassCache = false } = req.body;

  // 1. Validate
  const check = u.validateCmd(command);
  if (!check.ok) return res.json({ ok: false, output: 'ERR: ' + check.reason });

  // 2. Loop detection
  const loopResult = u.checkToolLoop(sessionId || 'default', command);
  if (loopResult.loop) {
    db.logError('tool-loop', new Error('Loop detected'), { cmd: loopResult.cmd, repeats: loopResult.repeats, sessionId });
    db.auditLog('exec.loop_blocked', { cmd: loopResult.cmd, repeats: loopResult.repeats });
    return res.json({ ok: false, output: `[LOOP DETECTED] Same command repeated ${loopResult.repeats}×. Try a different approach.`, loopDetected: true });
  }

  // 3. Safety score
  const safety = u.scoreToolSafety(command);
  if (safety.requiresNotice) db.auditLog('exec.safety', { cmd: command.slice(0,80), risk: safety.risk, score: safety.score });

  // 4. Cache check (skip for writes/mutations)
  if (!bypassCache && safety.score < 20) {
    const cached = getCachedTool(command);
    if (cached) return res.json({ ok: true, output: cached, cached: true });
  }

  const defaultCwd = fs.existsSync('/workspace') ? '/workspace' : __dirname;
  const execCwd = reqCwd ? path.resolve(reqCwd) : defaultCwd;

  console.log('[exec] ' + (command || '').slice(0, 80));
  db.auditLog('exec', { cmd: (command || '').slice(0, 80) });

  exec(command, { cwd: execCwd, timeout: 60000, maxBuffer: 1024*1024*16, encoding: 'utf8', env: { ...process.env }, shell: '/bin/bash' }, (err, stdout, stderr) => {
    const raw = err ? ((stdout||'') + '\n' + (stderr || err.message || '')).trim() : (stdout || '');
    const { text: output, truncated, originalLen } = u.truncateToolResult(raw);
    if (!err && safety.score < 20) setCachedTool(command, output);
    if (err) return res.json({ ok: false, output, exitCode: err.code || 1, errorType: u.classifyToolError(err.code||1, raw) });
    res.json({ ok: true, output, truncated: truncated || raw.length > 32000, originalLen });
  });
});

// Streaming exec (for long-running commands)
app.post('/api/exec/stream', requireAuth, rl(30), (req, res) => {
  const check = u.validateCmd(req.body.command);
  if (!check.ok) { res.json({ ok: false, output: 'ERR: ' + check.reason }); return; }
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
  const child = exec(req.body.command, { cwd: __dirname, timeout: 120000, env: { ...process.env }, shell: '/bin/bash' });
  child.stdout.on('data', d => res.write('data: ' + JSON.stringify({ type: 'stdout', text: d.toString() }) + '\n\n'));
  child.stderr.on('data', d => res.write('data: ' + JSON.stringify({ type: 'stderr', text: d.toString() }) + '\n\n'));
  child.on('close', code => { res.write('data: ' + JSON.stringify({ type: 'done', exitCode: code }) + '\n\n'); res.end(); });
  child.on('error', e => { res.write('data: ' + JSON.stringify({ type: 'error', text: e.message }) + '\n\n'); res.end(); });
  req.on('close', () => { try { child.kill(); } catch {} });
});

// Parallel exec (batch read-only commands)
app.post('/api/exec/parallel', rl(10), async (req, res) => {
  const { commands = [] } = req.body;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 10)
    return res.status(400).json({ error: 'Provide 1-10 commands' });
  const results = await Promise.allSettled(commands.map(cmd => new Promise(resolve => {
    if (!u.validateCmd(cmd).ok) { resolve({ ok: false, output: 'ERR: Invalid', cmd }); return; }
    const cached = getCachedTool(cmd); if (cached) { resolve({ ok: true, output: cached, cmd, cached: true }); return; }
    exec(cmd, { cwd: __dirname, timeout: 15000, maxBuffer: 1024*1024*4, encoding: 'utf8', shell: '/bin/bash' }, (err, stdout, stderr) => {
      const out = err ? ((stdout||'') + (stderr||err.message||'')).trim() : (stdout||'');
      if (!err) setCachedTool(cmd, out);
      resolve({ ok: !err, output: out.slice(0, 8000), cmd, exitCode: err?.code });
    });
  })));
  res.json({ results: results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message }) });
});

app.post('/api/exec/reset-loop', (req, res) => { u.resetLoopDetector((req.body.sessionId || 'default')); res.json({ ok: true }); });
app.post('/api/exec/destructive-check', (req, res) => { const { command = '' } = req.body; const { isDestructive, risk } = u.detectDestructive(command); res.json({ isDestructive, risk, requiresConfirmation: risk !== 'low' }); });
app.get('/api/exec/safety-check', (req, res) => { const cmd = req.query.cmd || ''; res.json({ ...u.scoreToolSafety(cmd), cmd: cmd.slice(0, 200) }); });
app.post('/api/abort/:reqId', (req, res) => { const e = activeStreams.get(req.params.reqId); if (e) { try { e.abort.abort(); } catch {} activeStreams.delete(req.params.reqId); res.json({ ok: true }); } else res.json({ ok: false }); });

// ── Docs / RAG ────────────────────────────────────────────────────────────────
app.post('/api/docs/ingest', rl(20), async (req, res) => {
  const { filename: rawName, data } = req.body;
  if (!rawName || !data) return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
  const filename = u.sanitizeFilename(rawName);
  try {
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 200*1024*1024) return res.status(400).json({ ok: false, error: 'FILE_TOO_LARGE' });
    const fpath = path.join(UPLOAD_DIR, filename);
    await fs.promises.writeFile(fpath, buf);
    const text = await u.extractText(filename, buf);
    if (!text || text.length < 10) return res.json({ ok: false, error: 'NO_TEXT_EXTRACTED' });
    const chunks = u.semanticChunk(text);
    const id = db.upsertDoc({ filename, filepath: fpath, relPath: './uploads/' + filename, size: buf.length, charCount: text.length, chunks: chunks.map((c, idx) => { const v = u.tfVector(c); return { idx, text: c, freq: v.freq, len: v.len }; }) });
    invalidateBm25Cache();
    db.auditLog('doc.ingest', { filename, chunks: chunks.length });
    res.json({ ok: true, id, chunks: chunks.length, chars: text.length });
  } catch(e) { db.logError('ingest', e, { filename }); res.status(500).json({ ok: false, error: 'INGEST_FAILED', detail: e.message }); }
});
app.get('/api/docs', (_, res) => res.json(db.getDocs()));
app.delete('/api/docs/:id', (req, res) => { try { const { doc, deleted } = db.deleteDoc(req.params.id); if (doc?.filepath) { try { fs.unlinkSync(doc.filepath); } catch {} } res.json({ ok: deleted }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.post('/api/docs/search', (req, res) => { const { query: rawQ, topK = 8, hybrid = false } = req.body; if (!rawQ || !u.validateStr(rawQ, 2000)) return res.json({ chunks: [] }); const result = doSearch(rawQ, topK, hybrid); try { db.addSearchHistory(rawQ, result.chunks.length, hybrid?'hybrid':'bm25'); } catch(_) {} res.json(result); });
app.post('/api/analyze', (req, res) => { const { message = '', messages = [] } = req.body; res.json({ intent: u.classifyIntent(message), complexity: u.scoreComplexity(message, messages), domain: u.detectDomain(message, messages), tone: u.detectTone(message), formatPref: u.detectFormatPref(messages), shouldThink: u.shouldThinkHeuristic(message), suggestedTemp: u.getAutoTemp(u.classifyIntent(message), u.detectDomain(message, messages), u.scoreComplexity(message, messages)) }); });

// ── Models ────────────────────────────────────────────────────────────────────
app.post('/api/fetch-models', async (req, res) => {
  if (!u.validateStr(req.body.url, 512)) return res.status(400).json({ success: false, error: 'INVALID_URL' });
  try { const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 8000); const r = await fetch(req.body.url, { signal: ac.signal }); clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); const d = await r.json(); res.json({ success: true, models: d.models || [] }); }
  catch(e) { res.json({ success: false, error: e.name === 'AbortError' ? 'Timed out' : e.message }); }
});
app.post('/api/models/pull', async (req, res) => {
  const { baseUrl, modelName } = req.body; if (!u.validateStr(modelName, 200)) return res.status(400).json({ error: 'INVALID_MODEL' });
  const base = (baseUrl || 'http://localhost:11434').replace('/api/tags', '').replace(/\/$/, '');
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
  try { const r = await fetch(base + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: modelName, stream: true }) }); if (!r.ok) { res.write('data: ' + JSON.stringify({ error: 'HTTP ' + r.status }) + '\n\n'); return res.end(); } let buf = ''; r.body.on('data', chunk => { buf += chunk.toString(); const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) { const t = l.trim(); if (t) res.write('data: ' + t + '\n\n'); } }); r.body.on('end', () => { res.write('data: {"status":"success","__done":true}\n\n'); res.end(); }); r.body.on('error', e => { res.write('data: ' + JSON.stringify({ error: e.message }) + '\n\n'); res.end(); }); }
  catch(e) { res.write('data: ' + JSON.stringify({ error: e.message }) + '\n\n'); res.end(); }
});
app.post('/api/models/delete', async (req, res) => { const { baseUrl, modelName } = req.body; const base = (baseUrl || 'http://localhost:11434').replace('/api/tags', '').replace(/\/$/, ''); try { const r = await fetch(base + '/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: modelName }) }); res.json({ ok: r.ok }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/title', async (req, res) => {
  const { baseUrl, model, content } = req.body; if (!model || !content) return res.json({ title: null });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const prompt = 'User message: ' + content.slice(0, 300) + '\n\nWrite a 3-5 word title for this conversation. Literal and descriptive. Reply with ONLY the words, no punctuation.';
  try { const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt, options: { temperature: 0.3, num_ctx: 512, num_predict: 20 } }) }); clearTimeout(timer); if (!r.ok) return res.json({ title: null }); const d = await r.json(); const title = (d.response || '').replace(/^[\d.\-*#>\s"'`]+/, '').replace(/["""''`*_#.!?,;:]/g, '').split('\n')[0].trim().slice(0, 50); res.json({ title: title || null }); }
  catch { res.json({ title: null }); }
});
app.post('/api/tokens/estimate', (req, res) => { const { messages = [], systemPrompt = '' } = req.body; const chars = messages.reduce((s, m) => s + (m.content || '').length, 0) + systemPrompt.length; res.json({ chars, estimatedTokens: Math.ceil(chars / 3.8), messages: messages.length }); });
app.get('/api/errors', (_, res) => res.json({ errors: db.getErrors() }));
app.delete('/api/errors', (_, res) => { try { db.clearErrors(); res.json({ ok: true }); } catch { res.json({ ok: false }); } });
app.get('/api/logs/stream', (req, res) => { res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); logClients.add(res); req.on('close', () => logClients.delete(res)); res.write('data: {"msg":"[SenecaChat log stream]"}\n\n'); });

// ── Google integrations ───────────────────────────────────────────────────────
app.get('/api/integrations/gdrive/list', async (req, res) => { try { const token = await getGoogleToken(); const rawQ = (req.query.q||'').replace(/'/g, "\\'"); const q = rawQ ? `name contains '${rawQ}'` : ''; const url = 'https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType,modifiedTime,size)' + (q ? '&q=' + encodeURIComponent(q) : '') + '&pageSize=50'; const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } }); const d = await r.json(); res.json({ ok: true, files: d.files || [] }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/integrations/gdrive/read/:fileId', async (req, res) => { try { const token = await getGoogleToken(); const meta = await fetch('https://www.googleapis.com/drive/v3/files/' + req.params.fileId + '?fields=name,mimeType', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json()); let content = ''; if (meta.mimeType === 'application/vnd.google-apps.document') { const r = await fetch('https://www.googleapis.com/drive/v3/files/' + req.params.fileId + '/export?mimeType=text/plain', { headers: { Authorization: 'Bearer ' + token } }); content = await r.text(); } else { const r = await fetch('https://www.googleapis.com/drive/v3/files/' + req.params.fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + token } }); content = await r.text(); } res.json({ ok: true, name: meta.name, content: content.slice(0, 100000) }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/gdrive/create', async (req, res) => { try { const token = await getGoogleToken(); const { name, content } = req.body; const boundary = 'b_' + crypto.randomBytes(8).toString('hex'); const body = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify({ name, mimeType: 'application/vnd.google-apps.document' }) + '\r\n--' + boundary + '\r\nContent-Type: text/plain\r\n\r\n' + (content || '') + '\r\n--' + boundary + '--'; const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary="' + boundary + '"' }, body }); const d = await r.json(); res.json({ ok: !!d.id, id: d.id, name: d.name }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/integrations/gsheets/read', async (req, res) => { try { const token = await getGoogleToken(); const { spreadsheetId, range } = req.query; if (!spreadsheetId) return res.json({ ok: false, error: 'spreadsheetId required' }); const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(range || 'Sheet1'), { headers: { Authorization: 'Bearer ' + token } }); const d = await r.json(); res.json({ ok: true, values: d.values || [], range: d.range }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/gsheets/write', async (req, res) => { try { const token = await getGoogleToken(); const { spreadsheetId, range, values } = req.body; const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(range || 'Sheet1') + '?valueInputOption=USER_ENTERED', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values }) }); const d = await r.json(); res.json({ ok: true, updatedCells: d.updatedCells }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/gsheets/append', async (req, res) => { try { const token = await getGoogleToken(); const { spreadsheetId, range, values } = req.body; const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(range || 'Sheet1') + ':append?valueInputOption=USER_ENTERED', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values }) }); const d = await r.json(); res.json({ ok: true, updates: d.updates }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/integrations/gcal/events', async (req, res) => { try { const token = await getGoogleToken(); const { calendarId = 'primary', timeMin, timeMax, maxResults = 20 } = req.query; const params = new URLSearchParams({ maxResults, singleEvents: true, orderBy: 'startTime' }); params.set('timeMin', timeMin || new Date().toISOString()); if (timeMax) params.set('timeMax', timeMax); const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events?' + params, { headers: { Authorization: 'Bearer ' + token } }); const d = await r.json(); res.json({ ok: true, events: (d.items || []).map(e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, description: e.description })) }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/gcal/create', async (req, res) => { try { const token = await getGoogleToken(); const { calendarId = 'primary', summary, start, end, description, location } = req.body; if (!summary || !start || !end) return res.json({ ok: false, error: 'summary, start, end required' }); const event = { summary, start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: end, timeZone: 'UTC' } }; if (description) event.description = description; if (location) event.location = location; const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }); const d = await r.json(); res.json({ ok: !!d.id, id: d.id, htmlLink: d.htmlLink }); } catch(e) { res.json({ ok: false, error: e.message }); } });

// ── Slack ─────────────────────────────────────────────────────────────────────
app.get('/api/integrations/slack/channels', async (_, res) => { try { const INT = getINT(); if (!INT.SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'SLACK_BOT_TOKEN not set' }); const r = await fetch('https://slack.com/api/conversations.list?limit=100', { headers: { Authorization: 'Bearer ' + INT.SLACK_BOT_TOKEN } }); const d = await r.json(); res.json({ ok: d.ok, channels: (d.channels || []).map(c => ({ id: c.id, name: c.name, num_members: c.num_members })) }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/slack/send', async (req, res) => { try { const INT = getINT(); if (!INT.SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'SLACK_BOT_TOKEN not set' }); const { channel, text } = req.body; if (!channel || !text) return res.json({ ok: false, error: 'channel and text required' }); const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: 'Bearer ' + INT.SLACK_BOT_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, text }) }); const d = await r.json(); res.json({ ok: d.ok, ts: d.ts, error: d.error }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/integrations/slack/messages', async (req, res) => { try { const INT = getINT(); if (!INT.SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'SLACK_BOT_TOKEN not set' }); const { channel, limit = 20 } = req.query; if (!channel) return res.json({ ok: false, error: 'channel required' }); const r = await fetch('https://slack.com/api/conversations.history?channel=' + channel + '&limit=' + limit, { headers: { Authorization: 'Bearer ' + INT.SLACK_BOT_TOKEN } }); const d = await r.json(); res.json({ ok: d.ok, messages: (d.messages || []).map(m => ({ ts: m.ts, text: m.text, user: m.user })) }); } catch(e) { res.json({ ok: false, error: e.message }); } });

// ── GitHub ─────────────────────────────────────────────────────────────────────
app.get('/api/integrations/github/repos', async (_, res) => { try { const INT = getINT(); if (!INT.GITHUB_TOKEN) return res.json({ ok: false, error: 'GITHUB_TOKEN not set' }); const r = await fetch('https://api.github.com/user/repos?per_page=50&sort=updated', { headers: { Authorization: 'token ' + INT.GITHUB_TOKEN, 'User-Agent': 'SenecaChat' } }); const d = await r.json(); if (!Array.isArray(d)) return res.json({ ok: false, error: d.message || 'Failed' }); res.json({ ok: true, repos: d.map(r => ({ id: r.id, name: r.full_name, description: r.description, private: r.private, stars: r.stargazers_count, updated: r.updated_at })) }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/github/issue', async (req, res) => { try { const INT = getINT(); if (!INT.GITHUB_TOKEN) return res.json({ ok: false, error: 'GITHUB_TOKEN not set' }); const { repo, title, body, labels } = req.body; if (!repo || !title) return res.json({ ok: false, error: 'repo and title required' }); const r = await fetch('https://api.github.com/repos/' + repo + '/issues', { method: 'POST', headers: { Authorization: 'token ' + INT.GITHUB_TOKEN, 'User-Agent': 'SenecaChat', 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body, labels }) }); const d = await r.json(); res.json({ ok: !!d.id, number: d.number, url: d.html_url }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/integrations/github/user', async (_, res) => { try { const INT = getINT(); if (!INT.GITHUB_TOKEN) return res.json({ ok: false, error: 'GITHUB_TOKEN not set' }); const r = await fetch('https://api.github.com/user', { headers: { Authorization: 'token ' + INT.GITHUB_TOKEN, 'User-Agent': 'SenecaChat' } }); const d = await r.json(); res.json({ ok: !!d.login, login: d.login, name: d.name, avatar_url: d.avatar_url }); } catch(e) { res.json({ ok: false, error: e.message }); } });

// ── Notion ────────────────────────────────────────────────────────────────────
app.get('/api/integrations/notion/search', async (req, res) => { try { const INT = getINT(); if (!INT.NOTION_TOKEN) return res.json({ ok: false, error: 'NOTION_TOKEN not set' }); const r = await fetch('https://api.notion.com/v1/search', { method: 'POST', headers: { Authorization: 'Bearer ' + INT.NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: req.query.q || '', page_size: 20 }) }); const d = await r.json(); res.json({ ok: true, results: (d.results || []).map(p => ({ id: p.id, type: p.object, title: p.properties?.title?.title?.[0]?.plain_text || 'Untitled', url: p.url })) }); } catch(e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/integrations/notion/page', async (req, res) => { try { const INT = getINT(); if (!INT.NOTION_TOKEN) return res.json({ ok: false, error: 'NOTION_TOKEN not set' }); const { parentId, title, content } = req.body; if (!parentId || !title) return res.json({ ok: false, error: 'parentId and title required' }); const blocks = (content || '').split('\n\n').filter(Boolean).map(para => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: para.slice(0, 2000) } }] } })); const r = await fetch('https://api.notion.com/v1/pages', { method: 'POST', headers: { Authorization: 'Bearer ' + INT.NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: { page_id: parentId }, properties: { title: { title: [{ type: 'text', text: { content: title } }] } }, children: blocks.slice(0, 100) }) }); const d = await r.json(); res.json({ ok: !!d.id, id: d.id, url: d.url }); } catch(e) { res.json({ ok: false, error: e.message }); } });

// ── Brave search ──────────────────────────────────────────────────────────────
app.get('/api/integrations/brave/search', async (req, res) => { try { const INT = getINT(); if (!INT.BRAVE_API_KEY) return res.json({ ok: false, error: 'BRAVE_API_KEY not set' }); const q = req.query.q; const count = Math.min(parseInt(req.query.count) || 8, 20); if (!q) return res.json({ ok: false, error: 'q is required' }); const params = new URLSearchParams({ q, count: String(count), search_lang: 'en', safesearch: 'moderate' }); const r = await fetch('https://api.search.brave.com/res/v1/web/search?' + params, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': INT.BRAVE_API_KEY } }); if (!r.ok) return res.json({ ok: false, error: 'Brave API error ' + r.status }); const d = await r.json(); res.json({ ok: true, query: q, results: (d.web?.results || []).map(x => ({ title: x.title, url: x.url, description: x.description })) }); } catch(e) { res.json({ ok: false, error: e.message }); } });

// ── SearXNG ───────────────────────────────────────────────────────────────────
app.get('/api/integrations/searxng/search', async (req, res) => {
  try {
    const INT = getINT();
    const base = (INT.SEARXNG_URL || 'http://localhost:8080').replace(/\/$/, '');
    const { q, count = 10, engines = '', lang = 'en' } = req.query;
    if (!q) return res.json({ ok: false, error: 'q is required' });
    const params = new URLSearchParams({ q, format: 'json', language: lang });
    if (engines) params.set('engines', engines);
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10000);
    const r = await fetch(`${base}/search?${params}`, { headers: { 'Accept': 'application/json' }, signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return res.json({ ok: false, error: `SearXNG HTTP ${r.status}` });
    const d = await r.json();
    res.json({ ok: true, query: q, total: d.number_of_results || 0, results: (d.results || []).slice(0, Math.min(count, 50)).map(x => ({ title: x.title, url: x.url, description: x.content || x.snippet || '', engine: x.engine, score: x.score })), suggestions: d.suggestions || [] });
  } catch(e) { res.json({ ok: false, error: e.name === 'AbortError' ? 'SearXNG timed out' : e.message }); }
});

// ── Agents ────────────────────────────────────────────────────────────────────
app.get('/api/agents', (_, res) => res.json(db.getAgents()));
app.post('/api/agents', (req, res) => { const { id, name, domain, systemPrompt, capabilities = [] } = req.body; if (!u.validateStr(id || '', 100) || !u.validateStr(name || '', 200) || !u.validateStr(systemPrompt || '', 5000)) return res.status(400).json({ error: 'INVALID' }); try { db.upsertAgent({ id, name, domain, systemPrompt, capabilities }); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/agents/:id', (req, res) => { if (db.DEFAULT_AGENTS.some(a => a.id === req.params.id)) return res.status(403).json({ error: 'Cannot delete built-in agent' }); try { db.deleteAgent(req.params.id); res.json({ ok: true }); } catch { res.status(500).json({ error: 'FAILED' }); } });
app.post('/api/agents/orchestrate', heavyLimiter, async (req, res) => {
  const { task, baseUrl, model } = req.body; if (!u.validateStr(task || '', 5000) || !model) return res.status(400).json({ error: 'INVALID' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const prompt = 'Decompose this task into 2-5 sub-tasks and assign each to one of: coder, researcher, writer, analyst, critic.\n\nTask: ' + task + '\n\nRespond ONLY as JSON: {"subtasks": [{"task": "...", "agentId": "...", "dependsOn": []}]}';
  try { const ac = new AbortController(); setTimeout(() => ac.abort(), 30000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt, options: { temperature: 0.2, num_ctx: 4096, num_predict: 500 } }) }); const d = await r.json(); let decomp; try { const m = (d.response || '').match(/\{[\s\S]*\}/); decomp = m ? JSON.parse(m[0]) : { subtasks: [] }; } catch { decomp = { subtasks: [] }; } const plan = u.createPlan(task, (decomp.subtasks || []).map(s => ({ description: '[' + s.agentId + '] ' + s.task, dependsOn: s.dependsOn || [] }))); db.upsertPlan(plan); res.json({ ok: true, plan, decomposition: decomp }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/agents/debate', heavyLimiter, async (req, res) => {
  const { topic, baseUrl, model } = req.body; if (!u.validateStr(topic || '', 2000) || !model) return res.status(400).json({ error: 'INVALID' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const positions = {};
    for (const side of ['for', 'against']) { const ac = new AbortController(); setTimeout(() => ac.abort(), 20000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt: 'Argue ' + side + ' this proposition. 3 strong arguments. 150 words max.\n\nProposition: ' + topic, options: { temperature: 0.6, num_ctx: 2048, num_predict: 300 } }) }); const d = await r.json(); positions[side] = d.response || ''; }
    const sr = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false, prompt: 'Two positions on: "' + topic + '"\n\nFOR:\n' + positions.for + '\n\nAGAINST:\n' + positions.against + '\n\nSynthesize a balanced conclusion in 100 words.', options: { temperature: 0.3, num_ctx: 2048, num_predict: 300 } }) }); const sd = await sr.json();
    res.json({ ok: true, topic, positions, synthesis: sd.response || '' });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/agents/peer-review', heavyLimiter, async (req, res) => {
  const { content, contentType = 'code', baseUrl, model } = req.body; if (!u.validateStr(content || '', 50000) || !model) return res.status(400).json({ error: 'INVALID' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const prompt = 'Review this ' + contentType + '. Identify: (1) critical bugs/errors, (2) missing edge cases, (3) style issues. Score 0-100.\n\n' + content.slice(0, 8000) + '\n\nFormat: {"score":N,"critical":["..."],"minor":["..."],"suggestions":["..."]}';
  try { const ac = new AbortController(); setTimeout(() => ac.abort(), 25000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt, options: { temperature: 0.2, num_ctx: 8192, num_predict: 600 } }) }); const d = await r.json(); let review; try { const m = (d.response || '').match(/\{[\s\S]*\}/); review = m ? JSON.parse(m[0]) : { score: 50, critical: [], minor: [], suggestions: [d.response || ''] }; } catch { review = { score: 50, critical: [], minor: [], suggestions: [d.response || ''] }; } res.json({ ok: true, review, reviewerAgent: 'critic' }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── Eval ──────────────────────────────────────────────────────────────────────
app.post('/api/eval/judge', heavyLimiter, async (req, res) => {
  const { response, query, baseUrl, model } = req.body; if (!u.validateStr(response || '', 50000) || !model) return res.status(400).json({ error: 'INVALID' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const prompt = 'Score this AI response: Relevance, Accuracy, Completeness, Clarity, Conciseness (0-10 each).\n\nQuestion: ' + (query || '').slice(0, 500) + '\nResponse: ' + response.slice(0, 2000) + '\n\nReply ONLY as JSON: {"relevance":N,"accuracy":N,"completeness":N,"clarity":N,"conciseness":N,"overall":N,"feedback":"one sentence"}';
  try { const ac = new AbortController(); setTimeout(() => ac.abort(), 20000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt, options: { temperature: 0.1, num_ctx: 4096, num_predict: 200 } }) }); const d = await r.json(); let scores; try { const m = (d.response || '').match(/\{[\s\S]*\}/); scores = m ? JSON.parse(m[0]) : { overall: 50 }; } catch { scores = { overall: 50 }; } db.recordMetric('llm_judge_score', scores.overall || 50, { query: (query || '').slice(0, 50) }); res.json({ ok: true, scores, model }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/eval/drift', (_, res) => { const quality = db.getMetrics('response_quality', 30); if (quality.length < 20) return res.json({ status: 'insufficient_data', dataPoints: quality.length }); const recent = quality.slice(0, 10).map(m => m.value); const baseline = quality.slice(10, 20).map(m => m.value); const avgR = recent.reduce((s, v) => s + v, 0) / recent.length; const avgB = baseline.reduce((s, v) => s + v, 0) / baseline.length; const delta = avgR - avgB; res.json({ status: Math.abs(delta) > 10 ? (delta < 0 ? 'degraded' : 'improved') : 'stable', avgRecent: Math.round(avgR), avgBaseline: Math.round(avgB), delta: Math.round(delta), driftDetected: Math.abs(delta) > 10 }); });
app.get('/api/eval/suite', (_, res) => res.json(db.getEvalSuites()));
app.post('/api/eval/suite', (req, res) => { const { name, tests = [] } = req.body; if (!u.validateStr(name || '', 200)) return res.status(400).json({ error: 'INVALID' }); try { const id = db.addEvalSuite({ name, tests }); res.json({ ok: true, id }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/eval/suite/:id/run', heavyLimiter, async (req, res) => {
  const { baseUrl, model } = req.body; if (!model) return res.status(400).json({ error: 'model required' });
  const suites = db.getEvalSuites(); const suite = suites.find(s => s.id === req.params.id);
  if (!suite) return res.status(404).json({ error: 'NOT_FOUND' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const results = []; const tests = suite.tests || [];
  for (const test of tests) { try { const ac = new AbortController(); setTimeout(() => ac.abort(), 20000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt: test.query, options: { temperature: 0.1, num_ctx: 2048, num_predict: 500 } }) }); const d = await r.json(); const response = d.response || ''; const passK = (test.expectedKeywords || []).every(k => response.toLowerCase().includes(k.toLowerCase())); const passMN = (test.mustNotContain || []).every(k => !response.toLowerCase().includes(k.toLowerCase())); test.lastResult = { passed: passK && passMN, response: response.slice(0, 500), ts: Date.now() }; test.lastRun = Date.now(); results.push({ testId: test.id, query: test.query, passed: passK && passMN }); } catch(e) { results.push({ testId: test.id, passed: false, error: e.message }); } }
  db.updateEvalSuite(req.params.id, tests);
  const passed = results.filter(r => r.passed).length;
  res.json({ ok: true, results, summary: { passed, total: results.length, pct: Math.round((passed / results.length) * 100) } });
});

// ── Health / System info ──────────────────────────────────────────────────────
app.get('/api/env', requireAuth, (req, res) => {
  const run = (cmd) => { try { return execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim(); } catch { return ''; } };
  const IS_DOCKER_NOW = fs.existsSync('/.dockerenv') || fs.existsSync('/workspace');
  res.json({
    platform: IS_DOCKER_NOW ? 'docker' : 'host',
    os: run('uname -sr'), hostname: run('hostname'), user: run('whoami'), cwd: __dirname,
    shell: process.env.SHELL || '/bin/bash', node: process.version,
    npm: run('npm --version'), python: run('python3 --version'), git: run('git --version'),
    disk: run("df -h . | tail -1 | awk '{print $4\" free of \"$2}'"),
    memory: run("free -h | awk '/^Mem/{print $3\" used / \"$2\" total\"}'"),
    env_vars: { has_openai: !!process.env.OPENAI_API_KEY, has_anthropic: !!process.env.ANTHROPIC_API_KEY, has_deepseek: !!process.env.DEEPSEEK_API_KEY, PORT: process.env.PORT || '3000', NODE_ENV: process.env.NODE_ENV || 'development' },
    tools: { curl: !!run('which curl'), wget: !!run('which wget'), jq: !!run('which jq'), docker: !!run('which docker'), sqlite3: !!run('which sqlite3'), ffmpeg: !!run('which ffmpeg') },
    permissions: { write_cwd: (() => { try { fs.accessSync(__dirname, fs.constants.W_OK); return true; } catch { return false; } })(), is_root: run('id -u') === '0' },
  });
});
app.get('/api/health', (_, res) => {
  const mem = process.memoryUsage(); const rq = db.getMetrics('response_quality', 20);
  const avgQ = rq.length ? Math.round(rq.reduce((s, m) => s + m.value, 0) / rq.length) : null;
  const d = db.getDb();
  res.json({ status: 'ok', version: '18.1.0', uptime: Math.round(process.uptime()), memory: { heapUsed: Math.round(mem.heapUsed/1024/1024) + 'MB', rss: Math.round(mem.rss/1024/1024) + 'MB' }, docs: d.prepare('SELECT COUNT(*) as n FROM docs').get().n, conversations: d.prepare('SELECT COUNT(*) as n FROM conversations').get().n, notes: d.prepare('SELECT COUNT(*) as n FROM notes').get().n, tasks: d.prepare('SELECT COUNT(*) as n FROM tasks').get().n, memoryEntries: d.prepare('SELECT COUNT(*) as n FROM memory').get().n, activePlans: d.prepare("SELECT COUNT(*) as n FROM plans WHERE status='active'").get().n, circuitBreaker: ollamaBreaker.status(), activeStreams: activeStreams.size, avgResponseQuality: avgQ, db: 'sqlite/wal', v18: { issues: d.prepare('SELECT COUNT(*) as n FROM issues').get().n, projects: d.prepare('SELECT COUNT(*) as n FROM projects').get().n, heartbeatRuns: d.prepare('SELECT COUNT(*) as n FROM heartbeat_runs').get().n, costEvents: d.prepare('SELECT COUNT(*) as n FROM cost_events').get().n, badges: db.getSidebarBadges() } });
});
app.get('/api/system/stats', (_, res) => {
  const mem = process.memoryUsage(); const d = db.getDb();
  const ns = {}; for (const n of db.MEMORY_NAMESPACES) ns[n] = d.prepare('SELECT COUNT(*) as c FROM memory WHERE namespace=?').get(n).c;
  res.json({ uptime: process.uptime(), memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss }, docs: { count: d.prepare('SELECT COUNT(*) as n FROM docs').get().n, totalChunks: d.prepare('SELECT COUNT(*) as n FROM doc_chunks').get().n }, conversations: { count: d.prepare('SELECT COUNT(*) as n FROM conversations').get().n }, memoryStore: { total: d.prepare('SELECT COUNT(*) as n FROM memory').get().n, byNamespace: ns }, circuitBreaker: ollamaBreaker.status(), activeStreams: activeStreams.size });
});

// ── Main Chat (SSE streaming) ─────────────────────────────────────────────────
//
// Provider detection: the server supports two wire formats:
//   1. Ollama   – POST /api/chat  { model, messages, stream, think, options:{num_ctx,temperature} }
//                 Response chunks: { message: { content: "..." }, done: bool }
//   2. OpenAI-compatible – POST /v1/chat/completions { model, messages, stream, temperature, max_tokens }
//                 Response chunks: data: { choices:[{ delta:{ content:"..." } }] }
//
// Detection heuristic (in priority order):
//   a. baseUrl contains "openai.com", "openrouter", "together", "groq", "mistral" → OpenAI
//   b. model name matches gpt-*, o1-*, o3-*, claude-* → OpenAI
//   c. baseUrl explicitly ends in /v1 → OpenAI
//   d. Otherwise → Ollama
//
function detectProvider(baseUrl, model) {
  const url = (baseUrl || '').toLowerCase();
  const m   = (model || '').toLowerCase();
  if (/openai\.com|openrouter\.ai|together\.ai|groq\.com|mistral\.ai|api\.anthropic|perplexity\.ai/.test(url)) return 'openai';
  if (/\/v1$/.test(url.replace(/\/$/, ''))) return 'openai';
  if (/^(gpt-|o1-|o3-|o4-|claude-|mistral-|llama-3|gemma-)/.test(m)) return 'openai';
  return 'ollama';
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { baseUrl, model, messages, thinkMode = 'off', ragChunks = [], allDocs = [], useRag = false, reqId, temperature, contextSize = 32768, autoExec = false, sessionId = '' } = req.body;
  if (!model || !u.validateStr(model, 200)) return res.status(400).json({ error: 'MISSING_MODEL' });
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'INVALID_MESSAGES' });

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastMsg = lastUser?.content || '';
  const base = (baseUrl || 'http://localhost:11434').replace('/api/tags', '').replace(/\/$/, '');

  // Classify message context
  const intent     = u.classifyIntent(lastMsg);
  const complexity = u.scoreComplexity(lastMsg, messages);
  const domain     = u.detectDomain(lastMsg, messages);
  const tone       = u.detectTone(lastMsg);
  const hasImages  = messages.some(m => m.images && m.images.length > 0);
  const effectiveTemp = temperature !== undefined ? temperature : u.getAutoTemp(intent, domain, complexity);

  // Load context
  const userPrefs         = db.getPrefs();
  const notes             = db.getNotes(10);
  const tasks             = db.getTasks();
  const integrationStatus = getIntegrationStatus();
  const agentMem          = db.getAgentMemory().slice(0, 20);
  const relevantMemory    = db.retrieveRelevantMemory(lastMsg, 6);

  // Injection detection
  if (lastUser && u.detectInjection(lastMsg)) {
    db.logError('injection-detected', new Error('Potential injection'), { content: lastMsg.slice(0, 200) });
    db.auditLog('security.injection', { preview: lastMsg.slice(0, 100) });
  }

  // Think mode
  let think = thinkMode === 'on' ? true : (thinkMode === 'auto' && lastUser ? u.shouldThinkHeuristic(lastMsg) : false);

  const prunedMessages = u.pruneMessages(messages, contextSize, 3000);
  const msgCount       = prunedMessages.filter(m => m.role === 'user').length;

  // Compaction snapshot injection (single-use)
  const compactionSnapshot = sessionId ? (compactionSnapshots.get(sessionId) || null) : null;
  if (compactionSnapshot && sessionId) compactionSnapshots.delete(sessionId);

  // Fallback think→off if context is near-full
  const rawBudget = u.buildTokenBudget(prunedMessages, '', contextSize);
  let effectiveThink = think;
  if (rawBudget.pct >= 85 && effectiveThink) {
    effectiveThink = false;
    db.auditLog('think.fallback', { sessionId, pct: rawBudget.pct });
  }
  const promptMode = rawBudget.pct >= 85 ? 'minimal' : 'full';

  // Session continuity (turn 0)
  let sessionContinuity = null;
  if (msgCount === 0 && sessionId) {
    try { const contRow = db.getDb().prepare('SELECT continuity_prompt FROM session_continuity WHERE session_id=?').get(sessionId); if (contRow?.continuity_prompt) sessionContinuity = contRow.continuity_prompt; } catch {}
    if (!sessionContinuity) {
      const keyFacts = db.getDb().prepare('SELECT content FROM memory WHERE namespace=? AND confidence>0.7 ORDER BY updated_at DESC LIMIT 5').all('project_facts');
      const errors   = db.getDb().prepare('SELECT content FROM memory WHERE namespace=? ORDER BY updated_at DESC LIMIT 3').all('past_errors');
      const parts = [keyFacts.length ? 'Key facts: ' + keyFacts.map(m => m.content).join('; ') : null, errors.length ? 'Known errors: ' + errors.map(m => m.content).join('; ') : null].filter(Boolean);
      if (parts.length) sessionContinuity = parts.join('\n');
    }
  }

  // Todo list
  let todoList = null;
  if (sessionId) { try { const todoRow = db.getDb().prepare('SELECT content FROM todos WHERE session_id=? ORDER BY updated_at DESC LIMIT 1').get(sessionId); if (todoRow?.content) todoList = todoRow.content; } catch {} }

  const sysP = buildSystemPrompt({ ragChunks: useRag ? ragChunks : [], allDocs, notes, tasks, thinkMode: effectiveThink ? 'on' : 'off', model, msgCount: prunedMessages.length, autoExec, integrationStatus, hasImages, intent, domain, complexity, tone, relevantMemory, userPrefs, sessionId, agentMem, promptMode, compactionSnapshot, todoList, sessionContinuity });
  const tokenBudget = u.buildTokenBudget(prunedMessages, sysP, contextSize);
  const needsCompact = u.shouldCompact(tokenBudget);
  const needsFlush   = needsCompact && sessionId && !memFlushFired.has(sessionId);

  console.log(`[chat] ${model.split(':')[0]} msgs=${messages.length}->${prunedMessages.length} intent=${intent} domain=${domain} temp=${effectiveTemp.toFixed(2)} think=${effectiveThink} budget=${tokenBudget.pct}%${needsCompact ? ' [COMPACT]' : ''}${promptMode === 'minimal' ? ' [MINIMAL]' : ''}`);

  if (!ollamaBreaker.canExecute()) {
    const wait = Math.ceil((ollamaBreaker.resetTimeout - (Date.now() - ollamaBreaker.lastFailure)) / 1000);
    return res.status(503).json({ error: 'CIRCUIT_OPEN', message: 'Ollama unreachable. Retry in ' + wait + 's.' });
  }

  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no');
  res.write('data: ' + JSON.stringify({ __meta: { intent, complexity, domain, tone, temperature: effectiveTemp, think: effectiveThink, tokenBudget, promptMode, needsCompact, needsFlush } }) + '\n\n');
  if (thinkMode === 'auto' && lastUser) res.write('data: ' + JSON.stringify({ __thinkDecision: effectiveThink }) + '\n\n');
  if (needsCompact) res.write('data: ' + JSON.stringify({ __compact: true, __needsFlush: needsFlush, sessionId }) + '\n\n');

  const abort = new AbortController();
  if (reqId) activeStreams.set(reqId, { abort, res });
  const cleanup = () => { if (reqId) activeStreams.delete(reqId); };

  // Build messages in the shared OpenAI format (role/content).
  // Ollama also accepts this format when sent to /api/chat.
  const chatMsgs = [{ role: 'system', content: sysP }, ...prunedMessages.map(m => {
    const out = { role: m.role, content: String(m.content || '').slice(0, 100000) };
    if (m.images && Array.isArray(m.images) && m.images.length) out.images = m.images;
    return out;
  })];
  const startTs = Date.now();
  const provider = detectProvider(base, model);

  // Dedup: skip if an identical short segment was already sent this response
  const sentNormalized = new Set();
  const normText = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);

  // ── Build upstream request based on provider ────────────────────────────
  let upstreamUrl, upstreamBody, upstreamHeaders;
  const INT = getINT();

  if (provider === 'openai') {
    // OpenAI-compatible (gpt-*, openrouter, groq, together, etc.)
    // - endpoint: baseUrl/v1/chat/completions  (or baseUrl/chat/completions if baseUrl already ends in /v1)
    // - no Ollama-specific fields (think, options.num_ctx)
    const v1base = /\/v1$/.test(base) ? base : base + '/v1';
    upstreamUrl = v1base + '/chat/completions';
    upstreamBody = JSON.stringify({
      model,
      messages: chatMsgs,
      stream: true,
      temperature: Math.max(0, Math.min(2, effectiveTemp)),
      max_tokens: 4096,
    });
    // Resolve API key: check env → DB secrets
    const apiKey = process.env.OPENAI_API_KEY || INT.OPENAI_API_KEY || '';
    upstreamHeaders = { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}) };
  } else {
    // Ollama native format
    upstreamUrl = base + '/api/chat';
    upstreamBody = JSON.stringify({
      model,
      messages: chatMsgs,
      stream: true,
      think: effectiveThink,
      options: { num_ctx: Math.max(2048, Math.min(131072, contextSize)), temperature: Math.max(0, Math.min(1.5, effectiveTemp)) },
    });
    upstreamHeaders = { 'Content-Type': 'application/json' };
  }

  console.log('[chat] provider=' + provider + ' url=' + upstreamUrl.slice(0, 60));

  try {
    const upstream = await withRetry(
      () => fetch(upstreamUrl, { method: 'POST', headers: upstreamHeaders, signal: abort.signal, body: upstreamBody }),
      { maxRetries: 2, baseDelay: 800, shouldRetry: (e, i) => {
        if (e.name === 'AbortError') return false;
        if (e.message?.includes('ECONNREFUSED')) { ollamaBreaker.onFailure(); return i < 1; }
        return true;
      }}
    );

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      ollamaBreaker.onFailure();
      res.write('data: ' + JSON.stringify({ error: provider + ' HTTP ' + upstream.status + (errBody ? ': ' + errBody.slice(0,200) : '') }) + '\n\n');
      cleanup(); return res.end();
    }
    ollamaBreaker.onSuccess();

    let buf = ''; let fullResponse = '';

    // DeepSeek (and some other models) leak special tokens into the output stream.
    // e.g. < | begin__of__sentence | > which then dumps internal logit scores as numbers.
    //
    // The original code used a "sliding window + abort" approach which FAILED because:
    // 1. Tokens split across chunk boundaries: "< | begin" arrives in chunk N,
    //    "__of__sentence | >" in chunk N+1. The first half was already sent before
    //    the full token assembled in the window and triggered the abort.
    // 2. Abort-on-detect = the garbage is already in the client's buffer.
    //
    // Fix: pending-buffer approach.
    // - Accumulate all incoming text in a `pending` string.
    // - Only forward text that is LOOKBACK chars behind the current tail
    //   (safe: can't be the start of a split token).
    // - Strip poison from the safe portion before sending.
    // - On stream end, flush everything with a final strip pass.
    // Covers: <|begin_of_sentence|>, < | begin__of__sentence | >, <｜begin▁of▁sentence｜>
    const LOOKBACK = 60;
    const POISON_STRIP = /<[\s\|｜]*(?:begin|end|pad|unk|sep|cls|mask|bos|eos)[^<>｜|]{0,50}[\|｜\s]*>/gi;
    let poisonPending = '';

    function stripPoisonPending(seg) {
      poisonPending += seg;
      if (poisonPending.length <= LOOKBACK) return '';
      const safe = poisonPending.slice(0, poisonPending.length - LOOKBACK);
      poisonPending = poisonPending.slice(poisonPending.length - LOOKBACK);
      return safe.replace(POISON_STRIP, '');
    }
    function flushPoisonPending() {
      const out = poisonPending.replace(POISON_STRIP, '');
      poisonPending = '';
      return out;
    }

    upstream.body.on('data', chunk => {
      buf += chunk.toString(); const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        // OpenAI SSE lines start with "data: "; Ollama lines are raw JSON.
        const raw = l.startsWith('data: ') ? l.slice(6) : l;
        const t = raw.trim();
        if (!t || t === '[DONE]') continue;
        try {
          const p = JSON.parse(t);

          // ── Extract content segment — handle both wire formats ────────────
          // Ollama:  { message: { content: "..." }, done: bool }
          // OpenAI:  { choices: [{ delta: { content: "..." } }] }
          let seg = null;
          if (p.message?.content !== undefined) {
            seg = p.message.content;                      // Ollama
          } else if (Array.isArray(p.choices)) {
            seg = p.choices[0]?.delta?.content ?? null;   // OpenAI
          }

          if (seg !== null && seg !== undefined && seg !== '') {
            const clean = stripPoisonPending(seg);
            if (!clean) continue; // still buffering or fully stripped
            fullResponse += clean;
            const norm = normText(clean);
            if (norm.length > 20 && sentNormalized.has(norm)) continue;
            if (norm.length > 20) sentNormalized.add(norm);
            // Normalize to Ollama format for client (client only knows Ollama shape)
            res.write('data: ' + JSON.stringify({ message: { content: clean } }) + '\n\n');
          } else if (!seg && !p.choices && !p.message) {
            // Non-content packet (done flag, stats, etc.) — forward as-is
            res.write('data: ' + t + '\n\n');
          }
        } catch { /* skip malformed JSON lines */ }
      }
    });

    upstream.body.on('end', () => {
      // Flush poison pending buffer and any remaining buf
      const tail = flushPoisonPending();
      if (tail) fullResponse += tail;
      if (buf.trim()) res.write('data: ' + buf.trim() + '\n\n');
      res.write('data: {"__done":true}\n\n'); cleanup(); res.end();
      const latency = Date.now() - startTs;
      const quality = u.scoreResponseQuality(fullResponse, lastMsg);
      const fmtScore = u.scoreResponseFormat(fullResponse, domain, intent);
      const adjustedQuality = Math.max(0, quality - fmtScore.penalty);
      db.recordMetric('response_quality', adjustedQuality, { intent, domain, complexity, latency, overFormatted: fmtScore.overFormatted });
      db.recordMetric('response_latency', latency, { model: model.split(':')[0] });
      db.auditLog('chat.complete', { model: model.split(':')[0], intent, domain, latency, quality });
      try {
        const estTokens  = Math.ceil(fullResponse.length / 3.8);
        const promptTokens = Math.ceil(sysP.length / 3.8) + Math.ceil(prunedMessages.reduce((s,m) => s+(m.content||'').length, 0)/3.8);
        db.recordCostEvent({ sessionId, agentId:'default', model: model.split(':')[0], provider:'ollama', inputTokens:promptTokens, outputTokens:estTokens, costCents:0 });
        db.logActivityV2({ actorType:'user', actorId:'user', action:'chat.completed', entityType:'session', entityId:sessionId||'anon', details:{ model:model.split(':')[0], intent, domain, latency, quality:adjustedQuality } });
        db.recordToolUsage('chat', true, latency);
      } catch(_) {}
      if (fullResponse.length > 100) db.setPrefs({ lastDomain: domain, lastModel: model });
    });
    upstream.body.on('error', e => { if (e.name !== 'AbortError') { ollamaBreaker.onFailure(); db.logError('stream-error', e); res.write('data: ' + JSON.stringify({ error: e.message }) + '\n\n'); } res.write('data: {"__done":true,"__aborted":true}\n\n'); cleanup(); res.end(); });
    req.on('close', () => { try { abort.abort(); } catch {} cleanup(); });
  } catch(e) {
    if (e.name !== 'AbortError') { ollamaBreaker.onFailure(); db.logError('chat-error', e); res.write('data: ' + JSON.stringify({ error: e.message || 'Connection failed' }) + '\n\n'); }
    else res.write('data: {"__done":true,"__aborted":true}\n\n');
    cleanup(); res.end();
  }
});

// ── Reflexion ─────────────────────────────────────────────────────────────────
app.post('/api/reflect', rl(20), async (req, res) => {
  const { baseUrl, model, query, response: failedResponse, error: errorContext = '', sessionId = '' } = req.body;
  if (!model || !query) return res.status(400).json({ error: 'model and query required' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const reflexionPrompt = u.buildReflexionPrompt(query, failedResponse || '', errorContext);
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 40000);
    const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt: reflexionPrompt, options: { temperature: 0.3, num_ctx: 8192, num_predict: 800 } }) });
    const d = await r.json();
    db.auditLog('reflect', { sessionId, queryLen: query.length });
    res.json({ ok: true, reflection: (d.response || '').trim(), sessionId });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── Todo ──────────────────────────────────────────────────────────────────────
app.get('/api/todo', (req, res) => { const { sessionId = 'default' } = req.query; try { const row = db.getDb().prepare('SELECT content, updated_at FROM todos WHERE session_id=?').get(sessionId); if (!row) return res.json({ ok: true, content: null, todos: [], sessionId }); const todos = u.parseTodoList(row.content); res.json({ ok: true, content: row.content, todos, updatedAt: row.updated_at, sessionId }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/todo', (req, res) => { const { sessionId = 'default', content, items } = req.body; if (!sessionId) return res.status(400).json({ error: 'sessionId required' }); try { let todoContent = content; if (!todoContent && items) todoContent = items.map(item => `[ ] ${item}`).join('\n'); if (!todoContent) return res.status(400).json({ error: 'content or items required' }); db.getDb().prepare('INSERT INTO todos (session_id, content, updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at').run(sessionId, todoContent, Date.now()); const todos = u.parseTodoList(todoContent); db.auditLog('todo.set', { sessionId, items: todos.length }); res.json({ ok: true, todos, sessionId }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.patch('/api/todo', (req, res) => { const { sessionId = 'default', index, status } = req.body; if (!['done', 'in_progress', 'pending'].includes(status)) return res.status(400).json({ error: 'invalid status' }); try { const row = db.getDb().prepare('SELECT content FROM todos WHERE session_id=?').get(sessionId); if (!row) return res.status(404).json({ error: 'no todo for session' }); const todos = u.parseTodoList(row.content); if (index < 0 || index >= todos.length) return res.status(400).json({ error: 'index out of range' }); todos[index].status = status; const newContent = u.formatTodoList(todos); db.getDb().prepare('UPDATE todos SET content=?, updated_at=? WHERE session_id=?').run(newContent, Date.now(), sessionId); res.json({ ok: true, todos, sessionId }); } catch(e) { res.status(500).json({ error: e.message }); } });

// ── Compaction ────────────────────────────────────────────────────────────────
app.post('/api/compact', rl(20), async (req, res) => {
  const { baseUrl, model, messages = [], sessionId = '', skipMemFlush = false } = req.body;
  if (!model || !messages.length) return res.status(400).json({ error: 'model and messages required' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');

  let flushResponse = null;
  if (!skipMemFlush && sessionId && !memFlushFired.has(sessionId)) {
    memFlushFired.add(sessionId);
    const flushPrompt = u.buildMemoryFlushPrompt();
    try { const ac = new AbortController(); setTimeout(() => ac.abort(), 20000); const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt: flushPrompt, options: { temperature: 0.1, num_ctx: 4096, num_predict: 400 } }) }); const d = await r.json(); flushResponse = (d.response || '').trim(); db.auditLog('compact.memflush', { sessionId, response: flushResponse.slice(0, 100) }); } catch(e) { db.logError('compact.memflush', e); }
  }

  const compactionPrompt = u.buildCompactionPromptV17(messages, 3);
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 40000);
    const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt: compactionPrompt, options: { temperature: 0.2, num_ctx: 16384, num_predict: 800 } }) });
    const d = await r.json();
    const summary = (d.response || '').trim();
    if (sessionId) compactionSnapshots.set(sessionId, summary);
    db.auditLog('compact.done', { sessionId, msgCount: messages.length, summaryLen: summary.length });
    db.recordMetric('compaction', 1, { sessionId, msgCount: messages.length });
    res.json({ ok: true, summary, sessionId, flushResponse, compactedMessages: [{ role: 'assistant', content: '[Session compacted. History summary injected into system prompt.]' }] });
  } catch(e) { db.logError('compact', e); res.json({ ok: false, error: e.message }); }
});
app.get('/api/compact/snapshot', (req, res) => { const { sessionId = '' } = req.query; res.json({ snapshot: sessionId ? (compactionSnapshots.get(sessionId) || null) : null, sessionId }); });

// ── Heartbeat ─────────────────────────────────────────────────────────────────
app.post('/api/heartbeat', rl(10), async (req, res) => {
  const { baseUrl, model, sessionId = 'heartbeat' } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const pendingTasks = db.getTasks().filter(t => t.status === 'pending').slice(0, 5);
  const agentMem     = db.getAgentMemory().slice(0, 10);
  let prompt = 'Read HEARTBEAT.md in the current directory if it exists and follow any instructions there.\nOnly act on tasks listed here.\n';
  if (pendingTasks.length) prompt += '\nPending tasks:\n' + pendingTasks.map(t => `- [${t.priority}] ${t.description}`).join('\n');
  if (agentMem.length) prompt += '\nAgent memory:\n' + agentMem.map(m => `${m.key}: ${m.value}`).join('\n');
  prompt += '\n\nIf nothing needs attention, reply exactly: HEARTBEAT_OK';
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 30000);
    const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ model, stream: false, prompt, options: { temperature: 0.1, num_ctx: 4096, num_predict: 300 } }) });
    const d = await r.json();
    const response = (d.response || '').trim();
    const noop = response === 'HEARTBEAT_OK' || response.includes('HEARTBEAT_OK');
    db.auditLog('heartbeat', { model: model.split(':')[0], noop, sessionId });
    res.json({ ok: true, response, noop, sessionId });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── Prompt Library ────────────────────────────────────────────────────────────
app.get('/api/prompts', (req, res) => { try { const cat = req.query.category || null; const limit = parseInt(req.query.limit) || 100; res.json({ ok: true, prompts: db.getPromptLibrary(cat).slice(0, limit) }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/prompts', (req, res) => { const { title, content, category = 'custom', tags = [] } = req.body; if (!title || !content) return res.status(400).json({ error: 'title and content required' }); try { const id = db.addPromptToLibrary({ title, content, category, tags }); res.json({ ok: true, id }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/prompts/:id', (req, res) => { try { db.deletePromptLibraryEntry(req.params.id); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/prompts/:id/use', (req, res) => { try { db.usePromptLibraryEntry(req.params.id); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

// ── v18 Route modules ─────────────────────────────────────────────────────────
app.use('/api/costs',    costsRouter);
app.use('/api/runs',     runsRouter);
app.use('/api',          kanbanRouter);
app.use('/api',          observabilityRouter);
app.use('/api',          convExtrasRouter);
app.use('/api',          extrasRouter);

// ── v18 System info ───────────────────────────────────────────────────────────
app.get('/api/system/info', (req, res) => {
  const d = db.getDb();
  res.json({ version: '18.1.0', features: db.getAllFeatureFlags().filter(f => f.enabled).map(f => f.flag), badges: db.getSidebarBadges(), costSummary: db.getCostSummary(), unreadNotifications: db.getUnreadNotificationCount(), runs: { total: d.prepare('SELECT COUNT(*) as n FROM heartbeat_runs').get().n, active: d.prepare("SELECT COUNT(*) as n FROM heartbeat_runs WHERE status IN ('queued','running')").get().n }, issues: { total: d.prepare('SELECT COUNT(*) as n FROM issues').get().n, todo: d.prepare("SELECT COUNT(*) as n FROM issues WHERE status='todo'").get().n }, projects: d.prepare("SELECT COUNT(*) as n FROM projects WHERE status='active'").get().n });
});

// ── Webhooks ──────────────────────────────────────────────────────────────────
async function deliverWebhooks(eventType, payload) {
  if (!db.getFeatureFlag('webhook_outbound')) return;
  const hooks = db.getWebhooks().filter(h => { const events = JSON.parse(h.events||'[]'); return events.length === 0 || events.includes(eventType) || events.includes('*'); });
  for (const hook of hooks) {
    try { const body = JSON.stringify({ event:eventType, ts:Date.now(), payload }); const sig = hook.secret ? crypto.createHmac('sha256', hook.secret).update(body).digest('hex') : ''; const _ac = new AbortController(); const _t = setTimeout(() => _ac.abort(), 8000); const r = await fetch(hook.url, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-SenecaChat-Event':eventType, 'X-SenecaChat-Sig':sig }, body, signal:_ac.signal }); clearTimeout(_t); db.updateWebhookFailCount(hook.id, !r.ok); } catch { db.updateWebhookFailCount(hook.id, true); }
  }
}

// ── Scheduled task polling ────────────────────────────────────────────────────
setInterval(() => { try { const due = db.getDueScheduledTasks(); for (const task of due) { db.logActivityV2({ actorType:'system', actorId:'scheduler', action:'scheduled_task.triggered', entityType:'scheduled_task', entityId:task.id, details:{ action:task.action } }); db.updateScheduledTaskRun(task.id, 'triggered'); } } catch(_) {} }, 60000);

// ── 404 / error handlers ──────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use((err, req, res, _next) => { db.logError('middleware', err, { path: req.path }); res.status(500).json({ error: 'INTERNAL_ERROR', traceId: req.traceId }); });

// =============================================================================
// BOOT
// =============================================================================
const server = app.listen(process.env.PORT || 3001, () => {
  const port = server.address().port;
  const INT = getINT(); const d = db.getDb();
  console.log('\n┌─────────────────────────────────────────────────────┐');
  console.log('│  SenecaChat v18.1.0  ⚡  SQLite · ReAct · AgentLoop  │');
  console.log('│  http://localhost:' + port + '                              │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log('│  Auth token:  data/.auth_token  (owner read-only)    │');
  console.log('│  Header:      Authorization: Bearer <token>          │');
  console.log('├─────────────────────────────────────────────────────┤');
  const checks = { Google: !!(INT.GOOGLE_CLIENT_ID && INT.GOOGLE_REFRESH_TOKEN), Slack: !!INT.SLACK_BOT_TOKEN, GitHub: !!INT.GITHUB_TOKEN, Notion: !!INT.NOTION_TOKEN, Brave: !!INT.BRAVE_API_KEY, SearXNG: !!INT.SEARXNG_URL };
  Object.entries(checks).forEach(([k, v]) => console.log('│  ' + (k + ':').padEnd(10) + (v ? '✓ ready' : '— not configured') + '                   │'));
  console.log('└─────────────────────────────────────────────────────┘');

  const tables = ['conversations','docs','notes','tasks','memory','plans'];
  for (const t of tables) { try { const n = d.prepare('SELECT COUNT(*) as c FROM ' + t).get().c; console.log('[boot] ' + t.padEnd(14) + ': ' + n + ' rows'); } catch {} }
  console.log('[boot] node         : ' + process.version + ' | pid: ' + process.pid + '\n');

  setInterval(() => db.applyMemoryDecay(), 60*60*1000);
  setInterval(() => db.pruneIdleSessions(10*60*1000), 5*60*1000);

  try { const reaped = db.reapOrphanedRuns(); if (reaped > 0) console.log('[boot] reaped ' + reaped + ' orphaned run(s)'); } catch(_) {}
  try { db.updateSidebarBadges(); } catch(_) {}
  try { const flags = db.getAllFeatureFlags().filter(f => f.enabled).map(f => f.flag); console.log('[boot] v18 features : ' + flags.join(', ')); } catch(_) {}

  // Auto-configure passwordless sudo
  try {
    const nodeUser = require('os').userInfo().username;
    if (nodeUser !== 'root') {
      const sudoersLine = nodeUser + ' ALL=(ALL) NOPASSWD: ALL';
      const sudoersFile = '/etc/sudoers.d/senecachat';
      try {
        const existing = fs.existsSync(sudoersFile) ? fs.readFileSync(sudoersFile, 'utf8') : '';
        if (!existing.includes(sudoersLine)) { fs.writeFileSync(sudoersFile, sudoersLine + '\n', { mode: 0o440 }); console.log('[boot] sudoers      : NOPASSWD granted to ' + nodeUser); }
        else console.log('[boot] sudoers      : already configured for ' + nodeUser);
      } catch { try { execSync('echo "' + sudoersLine + '" | sudo tee /etc/sudoers.d/senecachat > /dev/null', { timeout: 3000 }); } catch {} }
    }
  } catch(_) {}
});

function gracefulShutdown(sig) {
  console.log('\n[' + sig + '] Shutting down...');
  for (const [, e] of activeStreams) { try { e.abort.abort(); } catch {} }
  try { db.getDb().close(); } catch {}
  server.close(() => { console.log('Done.'); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', e => { db.logError('uncaughtException', e); gracefulShutdown('uncaughtException'); });
process.on('unhandledRejection', r => { db.logError('unhandledRejection', r instanceof Error ? r : new Error(String(r))); });
