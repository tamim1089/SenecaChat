'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/index');
const u = require('../utils/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── MODEL PERSONAS ────────────────────────────────────────────────────────────
router.get('/personas', (req, res) => res.json(db.getModelPersonas()));
router.post('/personas', (req, res) => {
  const { name, description='', systemPrompt, avatarEmoji='🤖', isDefault=0 } = req.body;
  if (!u.validateStr(name||'', 100) || !u.validateStr(systemPrompt||'', 10000)) return res.status(400).json({ error: 'INVALID' });
  const id = db.upsertModelPersona({ name, description, systemPrompt, avatarEmoji, isDefault });
  res.json({ ok:true, id });
});
router.patch('/personas/:id', (req, res) => {
  db.upsertModelPersona({ id: req.params.id, name:'', systemPrompt:'', ...req.body });
  res.json({ ok:true });
});
router.delete('/personas/:id', (req, res) => {
  db.deleteModelPersona(req.params.id);
  res.json({ ok:true });
});

// ── WEBHOOKS ──────────────────────────────────────────────────────────────────
router.get('/webhooks', requireAuth, (req, res) => res.json(db.getWebhooks()));
router.post('/webhooks', requireAuth, (req, res) => {
  const { url, events=[], secret='' } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'INVALID_URL' });
  const id = db.addWebhook({ url, events, secret });
  res.json({ ok:true, id });
});
router.delete('/webhooks/:id', requireAuth, (req, res) => {
  db.deleteWebhook(req.params.id);
  res.json({ ok:true });
});
// POST /api/webhooks/test/:id — fire a test payload
router.post('/webhooks/test/:id', requireAuth, async (req, res) => {
  const hooks = db.getWebhooks();
  const hook = hooks.find(h => h.id === req.params.id);
  if (!hook) return res.status(404).json({ error: 'NOT_FOUND' });
  const payload = JSON.stringify({ event:'test', ts: Date.now(), message:'SenecaChat webhook test' });
  try {
    const sig = hook.secret ? crypto.createHmac('sha256', hook.secret).update(payload).digest('hex') : '';
    const r = await require('node-fetch')(hook.url, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-SenecaChat-Sig':sig }, body:payload, timeout:10000 });
    db.updateWebhookFailCount(hook.id, !r.ok);
    res.json({ ok:r.ok, status: r.status });
  } catch(e) {
    db.updateWebhookFailCount(hook.id, true);
    res.json({ ok:false, error: e.message });
  }
});

// ── SCHEDULED TASKS ───────────────────────────────────────────────────────────
router.get('/scheduled', (req, res) => res.json(db.getScheduledTasks()));
router.post('/scheduled', requireAuth, (req, res) => {
  const { name, cron='', nextRunAt, action, payload={}, enabled=1 } = req.body;
  if (!u.validateStr(name||'', 200) || !action) return res.status(400).json({ error: 'INVALID' });
  const id = db.upsertScheduledTask({ name, cron, nextRunAt: nextRunAt||Date.now(), action, payload, enabled });
  res.json({ ok:true, id });
});
router.patch('/scheduled/:id', requireAuth, (req, res) => {
  db.upsertScheduledTask({ id:req.params.id, name:'', action:'', nextRunAt:Date.now(), ...req.body });
  res.json({ ok:true });
});

// ── API KEYS ──────────────────────────────────────────────────────────────────
router.get('/api-keys', requireAuth, (req, res) => res.json(db.listApiKeys()));
router.post('/api-keys', requireAuth, (req, res) => {
  const { name, permissions=['read'] } = req.body;
  if (!u.validateStr(name||'', 100)) return res.status(400).json({ error: 'INVALID_NAME' });
  const result = db.createApiKey(name, permissions);
  db.logActivityV2({ actorType:'user', actorId:'user', action:'api_key.created', entityType:'api_key', entityId:result.id, details:{ name } });
  res.json({ ok:true, ...result });
});
router.delete('/api-keys/:id', requireAuth, (req, res) => {
  db.deleteApiKey(req.params.id);
  db.logActivityV2({ actorType:'user', actorId:'user', action:'api_key.deleted', entityType:'api_key', entityId:req.params.id });
  res.json({ ok:true });
});

// ── BACKUP & RESTORE ──────────────────────────────────────────────────────────
router.get('/backup/manifest', requireAuth, (req, res) => res.json(db.getBackupManifest()));
router.post('/backup/create', requireAuth, (req, res) => {
  try {
    const dbPath = path.join(__dirname, '../../../data/seneca.db');
    const backupDir = path.join(__dirname, '../../../data/backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive:true });
    const ts = Date.now();
    const backupPath = path.join(backupDir, `seneca-backup-${ts}.db`);
    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);
    const id = db.logBackup({ backupPath, sizeBytes: stats.size, tablesIncluded:['all'] });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'backup.created', entityType:'backup', entityId:id||ts.toString(), details:{ sizeBytes: stats.size } });
    res.json({ ok:true, path: backupPath, sizeBytes: stats.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── INCOGNITO ─────────────────────────────────────────────────────────────────
router.post('/incognito/start', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  db.startIncognitoSession(sessionId);
  res.json({ ok:true, sessionId, incognito:true });
});
router.post('/incognito/end', (req, res) => {
  const { sessionId } = req.body;
  db.endIncognitoSession(sessionId);
  res.json({ ok:true });
});
router.get('/incognito/check', (req, res) => {
  const { sessionId } = req.query;
  res.json({ incognito: db.isIncognitoSession(sessionId||'') });
});

// ── TASK SESSIONS (Paperclip agentTaskSessions) ────────────────────────────────
router.get('/task-sessions/:agentId/:taskKey', (req, res) => {
  const s = db.getTaskSession(req.params.agentId, req.params.taskKey);
  res.json(s || { session_params:{}, workspace_cwd:'', workspace_source:'agent_home' });
});
router.post('/task-sessions', (req, res) => {
  const { agentId='default', taskKey, sessionParams={}, workspaceCwd='', workspaceSource='agent_home' } = req.body;
  if (!taskKey) return res.status(400).json({ error: 'taskKey required' });
  db.upsertTaskSession({ agentId, taskKey, sessionParams, workspaceCwd, workspaceSource });
  res.json({ ok:true });
});

// ── CODE DIFFS ────────────────────────────────────────────────────────────────
router.get('/code-diffs', (req, res) => res.json(db.getCodeDiffs(req.query.sessionId||null, parseInt(req.query.limit)||50)));
router.post('/code-diffs', (req, res) => {
  const { sessionId='', filename, beforeHash='', afterHash='', patch } = req.body;
  if (!filename || !patch) return res.status(400).json({ error: 'filename and patch required' });
  const id = db.addCodeDiff({ sessionId, filename, beforeHash, afterHash, patch });
  res.json({ ok:true, id });
});

// ── REQUEST TRACES ────────────────────────────────────────────────────────────
router.get('/traces', requireAuth, (req, res) => res.json(db.getRequestTraces(parseInt(req.query.limit)||100)));

// ── MEMORY CONSOLIDATION LOG ──────────────────────────────────────────────────
router.get('/memory-consolidations', (req, res) => res.json(db.getMemoryConsolidations(parseInt(req.query.limit)||20)));

module.exports = router;
