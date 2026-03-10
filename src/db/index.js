'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'seneca.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');      // concurrent reads + writes
    db.pragma('synchronous = NORMAL');   // fast but safe
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -64000');    // 64MB cache
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT DEFAULT '',
      message_count INTEGER DEFAULT 0,
      messages TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'project_facts',
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.8,
      access_count INTEGER DEFAULT 0,
      expires_at INTEGER,
      decayed INTEGER DEFAULT 0,
      links TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory(namespace);
    CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tag TEXT DEFAULT 'general',
      pinned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      filepath TEXT,
      rel_path TEXT,
      size INTEGER DEFAULT 0,
      char_count INTEGER DEFAULT 0,
      ingested_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      freq TEXT DEFAULT '{}',
      len INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON doc_chunks(doc_id);

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      steps TEXT DEFAULT '[]',
      milestones TEXT DEFAULT '[]',
      adaptations TEXT DEFAULT '[]',
      current_step INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      value REAL,
      meta TEXT DEFAULT '{}',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_type_ts ON metrics(type, ts DESC);

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      rating TEXT NOT NULL,
      comment TEXT DEFAULT '',
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

    CREATE TABLE IF NOT EXISTS errors_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ctx TEXT NOT NULL,
      msg TEXT NOT NULL,
      extra TEXT DEFAULT '{}',
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      description TEXT DEFAULT '',
      payload TEXT DEFAULT '{}',
      session_id TEXT DEFAULT '',
      risk_level TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      context TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data TEXT DEFAULT '{}',
      last_activity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'code',
      version INTEGER DEFAULT 1,
      session_id TEXT DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_artifact ON revisions(artifact_id);

    CREATE TABLE IF NOT EXISTS trajectories (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      steps TEXT DEFAULT '[]',
      outcome TEXT DEFAULT 'unknown',
      step_count INTEGER DEFAULT 0,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ab_tests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variant_a TEXT DEFAULT '{}',
      variant_b TEXT DEFAULT '{}',
      description TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      results_a TEXT DEFAULT '[]',
      results_b TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_suites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tests TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT DEFAULT 'general',
      system_prompt TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]',
      ephemeral INTEGER DEFAULT 0,
      spawned_from TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      task_id TEXT,
      content TEXT NOT NULL,
      expected_format TEXT DEFAULT 'text',
      priority TEXT DEFAULT 'normal',
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      agent_id TEXT DEFAULT '',
      priority INTEGER DEFAULT 5,
      session_id TEXT DEFAULT '',
      status TEXT DEFAULT 'queued',
      enqueued_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS improvements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT DEFAULT '',
      aspect TEXT DEFAULT 'content',
      correction TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL,
      hash TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      session_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // ── Migrations: safely add columns missing in older DBs ──────────────────
  const migrations = [
    "ALTER TABLE conversations ADD COLUMN messages TEXT DEFAULT '[]'",
    "ALTER TABLE conversations ADD COLUMN message_count INTEGER DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN model TEXT DEFAULT ''",
    "ALTER TABLE conversations ADD COLUMN created_at INTEGER",
    "ALTER TABLE conversations ADD COLUMN updated_at INTEGER",
  ];
  for (const sql of migrations) {
    try { d.prepare(sql).run(); } catch (_) { /* column already exists */ }
  }

  // ── v18 Schema Extension ──────────────────────────────────────────────────
  const { SCHEMA_V18 } = require('./schema-v18');
  d.exec(SCHEMA_V18);

  // ── v18 Migrations ────────────────────────────────────────────────────────
  const v18Migrations = [
    "ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'active'",
    "ALTER TABLE agents ADD COLUMN budget_monthly_cents INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN spent_monthly_cents INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN concurrent_runs_max INTEGER DEFAULT 1",
    "ALTER TABLE agents ADD COLUMN updated_at INTEGER",
    "ALTER TABLE approvals ADD COLUMN approval_type TEXT DEFAULT 'action'",
    "ALTER TABLE approvals ADD COLUMN requester_agent TEXT DEFAULT ''",
    "ALTER TABLE approvals ADD COLUMN run_id TEXT DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN project_id TEXT DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN goal_id TEXT DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN assignee TEXT DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN due_date INTEGER",
    "ALTER TABLE tasks ADD COLUMN labels TEXT DEFAULT '[]'",
    "ALTER TABLE conversations ADD COLUMN tags TEXT DEFAULT '[]'",
    "ALTER TABLE conversations ADD COLUMN branch_count INTEGER DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN pinned INTEGER DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN token_count INTEGER DEFAULT 0",
  ];
  for (const sql of v18Migrations) {
    try { d.prepare(sql).run(); } catch (_) { /* already exists */ }
  }

  // ── Seed default feature flags ────────────────────────────────────────────
  const defaultFlags = [
    ['cost_tracking', 1, 'Track token costs per session'],
    ['heartbeat_runs', 1, 'Enable autonomous heartbeat runs'],
    ['activity_log_v2', 1, 'Structured activity audit log'],
    ['kanban_view', 1, 'Kanban board for issues/tasks'],
    ['incognito_mode', 1, 'Privacy/incognito sessions'],
    ['webhook_outbound', 0, 'Outbound webhook delivery'],
    ['model_comparison', 1, 'Side-by-side model comparison'],
    ['conversation_branches', 1, 'Branched conversations'],
    ['sidebar_badges', 1, 'Unread/pending badges'],
    ['smart_notifications', 1, 'Notification center'],
    ['code_diff_tracking', 1, 'Track code changes across sessions'],
    ['request_tracing', 0, 'Per-request trace logging'],
    ['prompt_library', 1, 'Shared prompt library'],
    ['schedule_tasks', 1, 'Scheduled task automation'],
    ['clipboard_history', 1, 'Clipboard history tracking'],
  ];
  const flagStmt = d.prepare('INSERT OR IGNORE INTO feature_flags(flag,enabled,description,updated_at) VALUES(?,?,?,?)');
  for (const [flag, enabled, description] of defaultFlags) {
    try { flagStmt.run(flag, enabled, description, Date.now()); } catch (_) {}
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function now() { return Date.now(); }
function uid() { return crypto.randomUUID(); }
function json(v) { return JSON.stringify(v); }
function parse(v, fallback = null) {
  try { return JSON.parse(v); } catch { return fallback; }
}

// ── Conversations ─────────────────────────────────────────────────────────────
const convStmts = {
  list:    null, get: null, upsert: null, del: null, search: null, bulkDel: null
};

function prepareConvStmts(d) {
  if (convStmts.list) return;
  convStmts.list    = d.prepare('SELECT id, name, model, message_count, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200');
  convStmts.get     = d.prepare('SELECT * FROM conversations WHERE id = ?');
  convStmts.upsert  = d.prepare(`INSERT INTO conversations(id,name,model,message_count,messages,created_at,updated_at)
    VALUES(@id,@name,@model,@message_count,@messages,@created_at,@updated_at)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, model=excluded.model,
      message_count=excluded.message_count, messages=excluded.messages, updated_at=excluded.updated_at`);
  convStmts.del     = d.prepare('DELETE FROM conversations WHERE id = ?');
  convStmts.patch   = d.prepare('UPDATE conversations SET name=?, updated_at=? WHERE id=?');
  convStmts.search  = d.prepare("SELECT id,name,model,message_count,messages FROM conversations WHERE name LIKE ? OR messages LIKE ? ORDER BY updated_at DESC LIMIT 20");
  convStmts.bulkDel = d.prepare('DELETE FROM conversations WHERE id = ?');
}

function listConversations() {
  const d = getDb(); prepareConvStmts(d);
  return convStmts.list.all();
}
function getConversation(id) {
  const d = getDb(); prepareConvStmts(d);
  const row = convStmts.get.get(id);
  if (!row) return null;
  row.messages = parse(row.messages, []);
  return row;
}
function upsertConversation({ id, name, model, messages }) {
  const d = getDb(); prepareConvStmts(d);
  const existing = convStmts.get.get(id);
  const ts = now();
  convStmts.upsert.run({ id, name: (name||'New Chat').slice(0,400), model: model||'', message_count: (messages||[]).length, messages: json((messages||[]).slice(-4000)), created_at: existing?.created_at || ts, updated_at: ts });
  return id;
}
function deleteConversation(id) { const d = getDb(); prepareConvStmts(d); convStmts.del.run(id); }
function patchConversation(id, name) { const d = getDb(); prepareConvStmts(d); convStmts.patch.run(name.slice(0,400), now(), id); }
function searchConversations(q) {
  const d = getDb(); prepareConvStmts(d);
  const like = `%${q}%`;
  return convStmts.search.all(like, like).map(r => ({ ...r, messages: parse(r.messages, []) }));
}
function bulkDeleteConversations(ids) {
  const d = getDb(); prepareConvStmts(d);
  const del = d.transaction((ids) => { for (const id of ids) convStmts.del.run(id); });
  del(ids);
}
function exportConversation(id) {
  const conv = getConversation(id);
  if (!conv) return null;
  return ['# ' + conv.name, '', `*Exported: ${new Date().toLocaleString()}*`, `*Model: ${conv.model||'unknown'}*`, '---', '']
    .concat((conv.messages||[]).map(m => `**${m.role.toUpperCase()}**\n\n${m.content}\n\n---`)).join('\n');
}
function duplicateConversation(id) {
  const src = getConversation(id);
  if (!src) return null;
  const clone = { ...src, id: uid(), name: src.name + ' (copy)', messages: src.messages };
  upsertConversation(clone);
  return clone.id;
}

// ── Memory ────────────────────────────────────────────────────────────────────
const MEMORY_NAMESPACES = ['user_prefs','project_facts','past_errors','patterns','episodes'];

function storeMemory({ namespace='project_facts', key, content, confidence=0.8, expiresIn=null }) {
  if (!MEMORY_NAMESPACES.includes(namespace)) namespace = 'project_facts';
  const d = getDb();
  const id = uid();
  const ts = now();
  const expiresAt = expiresIn ? ts + expiresIn : null;
  d.prepare(`INSERT INTO memory(id,namespace,key,content,confidence,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(namespace,key) DO UPDATE SET content=excluded.content, confidence=excluded.confidence,
      expires_at=excluded.expires_at, updated_at=excluded.updated_at, decayed=0`
  ).run(id, namespace, key, typeof content === 'string' ? content : json(content), Math.max(0, Math.min(1, confidence)), expiresAt, ts, ts);
  return { id, namespace, key };
}

function loadMemory(namespace = null, limit = 2000) {
  const d = getDb();
  const ts = now();
  if (namespace) {
    return d.prepare('SELECT * FROM memory WHERE namespace=? AND confidence>0.1 AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT ?').all(namespace, ts, limit);
  }
  return d.prepare('SELECT * FROM memory WHERE confidence>0.1 AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT ?').all(ts, limit);
}

function retrieveRelevantMemory(query, topK = 8, minConf = 0.3) {
  if (!query) return loadMemory(null, topK);
  const d = getDb();
  const ts = now();
  const mem = d.prepare('SELECT * FROM memory WHERE confidence>=? AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 500').all(minConf, ts);
  const scored = mem.map(m => ({ ...m, score: cosineSim(query, m.content + ' ' + m.key) * m.confidence })).filter(m => m.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function applyMemoryDecay() {
  const d = getDb();
  const DECAY_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = now() - DECAY_MS;
  d.prepare("UPDATE memory SET confidence=MAX(0.1, confidence*0.7), decayed=1 WHERE decayed=0 AND created_at<?").run(cutoff);
}

// ── Notes ─────────────────────────────────────────────────────────────────────
function getNotes(limit = 500) { return getDb().prepare('SELECT * FROM notes ORDER BY pinned DESC, created_at DESC LIMIT ?').all(limit); }
function addNote({ content, tag = 'general', pinned = 0 }) {
  const d = getDb(); const id = uid();
  d.prepare('INSERT INTO notes VALUES(?,?,?,?,?)').run(id, content.trim().slice(0,4000), tag, pinned ? 1 : 0, now());
  return id;
}
function patchNote(id, updates) {
  const existing = getDb().prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!existing) return false;
  const merged = { ...existing, ...updates };
  getDb().prepare('UPDATE notes SET content=?,tag=?,pinned=? WHERE id=?').run(merged.content, merged.tag, merged.pinned ? 1 : 0, id);
  return true;
}
function deleteNote(id) { getDb().prepare('DELETE FROM notes WHERE id=?').run(id); }
function clearNotes() { getDb().prepare('DELETE FROM notes').run(); }

// ── Tasks ─────────────────────────────────────────────────────────────────────
function getTasks() { return getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all(); }
function addTask({ description, priority = 'normal' }) {
  const d = getDb(); const id = uid(); const ts = now();
  d.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id, description.trim().slice(0,2000), 'pending', priority, ts, ts);
  return id;
}
function patchTask(id, updates) {
  const allowed = ['status','priority','description'];
  const d = getDb(); const ts = now();
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) d.prepare(`UPDATE tasks SET ${k}=?, updated_at=? WHERE id=?`).run(v, ts, id);
  }
}
function deleteTask(id) { getDb().prepare('DELETE FROM tasks WHERE id=?').run(id); }

// ── Docs / RAG ────────────────────────────────────────────────────────────────
function getDocs() {
  return getDb().prepare('SELECT d.id,d.filename,d.filepath,d.rel_path,d.size,d.char_count,d.ingested_at,COUNT(c.id) as chunks FROM docs d LEFT JOIN doc_chunks c ON c.doc_id=d.id GROUP BY d.id ORDER BY d.ingested_at DESC').all();
}
function getDocWithChunks(id) {
  const d = getDb();
  const doc = d.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) return null;
  doc.chunks = d.prepare('SELECT * FROM doc_chunks WHERE doc_id=? ORDER BY idx').all(id).map(c => ({ ...c, freq: parse(c.freq, {}) }));
  return doc;
}
function upsertDoc({ id, filename, filepath, relPath, size, charCount, chunks }) {
  const d = getDb(); const ts = now();
  d.prepare('DELETE FROM docs WHERE filename=?').run(filename);
  d.prepare('INSERT OR REPLACE INTO docs(id,filename,filepath,rel_path,size,char_count,ingested_at) VALUES(?,?,?,?,?,?,?)').run(id||uid(), filename, filepath, relPath, size, charCount, ts);
  const docId = d.prepare('SELECT id FROM docs WHERE filename=?').get(filename).id;
  const insertChunk = d.prepare('INSERT INTO doc_chunks(doc_id,idx,text,freq,len) VALUES(?,?,?,?,?)');
  const insertMany = d.transaction((chunks) => { for (const c of chunks) insertChunk.run(docId, c.idx, c.text, json(c.freq||{}), c.len||0); });
  insertMany(chunks);
  return docId;
}
function deleteDoc(id) {
  const d = getDb();
  const doc = d.prepare('SELECT * FROM docs WHERE id=?').get(id);
  return { doc, deleted: d.prepare('DELETE FROM docs WHERE id=?').run(id).changes > 0 };
}
function getAllChunks() {
  return getDb().prepare('SELECT c.*,d.filename,d.rel_path,d.ingested_at FROM doc_chunks c JOIN docs d ON d.id=c.doc_id').all()
    .map(c => ({ ...c, freq: parse(c.freq, {}) }));
}

// ── Plans ─────────────────────────────────────────────────────────────────────
function getPlans() {
  return getDb().prepare('SELECT * FROM plans ORDER BY created_at DESC LIMIT 50').all().map(p => ({
    ...p, steps: parse(p.steps, []), milestones: parse(p.milestones, []), adaptations: parse(p.adaptations, [])
  }));
}
function getPlan(id) {
  const p = getDb().prepare('SELECT * FROM plans WHERE id=?').get(id);
  if (!p) return null;
  return { ...p, steps: parse(p.steps, []), milestones: parse(p.milestones, []), adaptations: parse(p.adaptations, []) };
}
function upsertPlan(plan) {
  const d = getDb(); const ts = now();
  d.prepare(`INSERT INTO plans(id,task,status,steps,milestones,adaptations,current_step,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET task=excluded.task,status=excluded.status,steps=excluded.steps,
      milestones=excluded.milestones,adaptations=excluded.adaptations,current_step=excluded.current_step,updated_at=excluded.updated_at`
  ).run(plan.id, plan.task, plan.status||'active', json(plan.steps||[]), json(plan.milestones||[]), json(plan.adaptations||[]), plan.currentStep||0, plan.createdAt||ts, ts);
}
function deletePlan(id) { getDb().prepare('DELETE FROM plans WHERE id=?').run(id); }

// ── Metrics ───────────────────────────────────────────────────────────────────
function recordMetric(type, value, meta = {}) {
  getDb().prepare('INSERT INTO metrics(type,value,meta,ts) VALUES(?,?,?,?)').run(type, value, json(meta), now());
  // Prune old metrics (keep last 10000)
  getDb().prepare('DELETE FROM metrics WHERE id NOT IN (SELECT id FROM metrics ORDER BY ts DESC LIMIT 10000)').run();
}
function getMetrics(type = null, last = 100) {
  if (type) return getDb().prepare('SELECT * FROM metrics WHERE type=? ORDER BY ts DESC LIMIT ?').all(type, last);
  return getDb().prepare('SELECT * FROM metrics ORDER BY ts DESC LIMIT ?').all(last);
}
function getMetricsSummary() {
  const rows = getDb().prepare('SELECT type, COUNT(*) as count, AVG(value) as avg, SUM(value) as sum FROM metrics GROUP BY type').all();
  const s = {};
  for (const r of rows) s[r.type] = { count: r.count, avg: Math.round(r.avg||0), sum: r.sum };
  return s;
}

// ── Audit ─────────────────────────────────────────────────────────────────────
function auditLog(action, details = {}) {
  getDb().prepare('INSERT INTO audit_log(action,details,ts) VALUES(?,?,?)').run(action, json(details), now());
}
function getAuditLog(limit = 200) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit);
}

// ── Errors ────────────────────────────────────────────────────────────────────
function logError(ctx, err, extra = {}) {
  const msg = err?.message || String(err);
  try { getDb().prepare('INSERT INTO errors_log(ctx,msg,extra,ts) VALUES(?,?,?,?)').run(ctx, msg, json(extra), now()); } catch {}
  console.error(`[${ctx}]`, msg);
}
function getErrors(limit = 50) { return getDb().prepare('SELECT * FROM errors_log ORDER BY ts DESC LIMIT ?').all(limit); }
function clearErrors() { getDb().prepare('DELETE FROM errors_log').run(); }

// ── Approvals ─────────────────────────────────────────────────────────────────
function addApproval({ id, action, description, payload, sessionId, riskLevel }) {
  const ts = now();
  getDb().prepare('INSERT INTO approvals(id,action,description,payload,session_id,risk_level,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id||uid(), action, description||'', json(payload||{}), sessionId||'', riskLevel||'medium', 'pending', ts, ts + 5*60*1000);
}
function getApproval(id) { return getDb().prepare('SELECT * FROM approvals WHERE id=?').get(id); }
function getApprovals() { return getDb().prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100').all(); }
function resolveApproval(id, status) {
  getDb().prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(status, now(), id);
}

// ── Secrets ───────────────────────────────────────────────────────────────────
function getSecrets() {
  const rows = getDb().prepare('SELECT key,value FROM secrets').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
function setSecret(key, value) {
  if (!value) { getDb().prepare('DELETE FROM secrets WHERE key=?').run(key); return; }
  getDb().prepare('INSERT OR REPLACE INTO secrets(key,value) VALUES(?,?)').run(key, value);
}
function deleteSecret(key) { getDb().prepare('DELETE FROM secrets WHERE key=?').run(key); }

// ── User Prefs ────────────────────────────────────────────────────────────────
function getPrefs() {
  const rows = getDb().prepare('SELECT key,value FROM user_prefs').all();
  const p = {};
  for (const r of rows) p[r.key] = parse(r.value, r.value);
  return p;
}
function setPrefs(updates) {
  const d = getDb(); const ts = now();
  const stmt = d.prepare('INSERT OR REPLACE INTO user_prefs(key,value,updated_at) VALUES(?,?,?)');
  const run = d.transaction((updates) => { for (const [k,v] of Object.entries(updates)) stmt.run(k, json(v), ts); });
  run(updates);
}

// ── Agent Memory (legacy KV) ──────────────────────────────────────────────────
function getAgentMemory() { return getDb().prepare('SELECT * FROM agent_memory ORDER BY updated_at DESC LIMIT 500').all().map(r => ({ key: r.key, value: parse(r.value, r.value), updatedAt: r.updated_at })); }
function setAgentMemory(key, value) { getDb().prepare('INSERT OR REPLACE INTO agent_memory(key,value,updated_at) VALUES(?,?,?)').run(key, json(value), now()); }
function deleteAgentMemory(key) { if (key) { getDb().prepare('DELETE FROM agent_memory WHERE key=?').run(key); } else { getDb().prepare('DELETE FROM agent_memory').run(); } }

// ── Templates ─────────────────────────────────────────────────────────────────
function getTemplates() { return getDb().prepare('SELECT * FROM templates ORDER BY created_at DESC LIMIT 100').all(); }
function addTemplate({ title, content, category = 'general' }) {
  const id = uid();
  getDb().prepare('INSERT INTO templates VALUES(?,?,?,?,?)').run(id, title.trim().slice(0,200), content.trim().slice(0,10000), category, now());
  return id;
}
function deleteTemplate(id) { getDb().prepare('DELETE FROM templates WHERE id=?').run(id); }

// ── Sessions ──────────────────────────────────────────────────────────────────
function getSession(id) { const r = getDb().prepare('SELECT * FROM sessions WHERE id=?').get(id); return r ? parse(r.data, {}) : {}; }
function setSession(id, data) { getDb().prepare('INSERT OR REPLACE INTO sessions(id,data,last_activity) VALUES(?,?,?)').run(id, json(data), now()); }
function pruneIdleSessions(idleMs = 10 * 60 * 1000) { getDb().prepare('DELETE FROM sessions WHERE last_activity<?').run(now() - idleMs); }

// ── KV store (general) ────────────────────────────────────────────────────────
function kvGet(key) { const r = getDb().prepare('SELECT value FROM kv_store WHERE key=?').get(key); return r ? parse(r.value, r.value) : null; }
function kvSet(key, value) { getDb().prepare('INSERT OR REPLACE INTO kv_store(key,value,updated_at) VALUES(?,?,?)').run(key, json(value), now()); }
function kvDelete(key) { getDb().prepare('DELETE FROM kv_store WHERE key=?').run(key); }

// ── Agents ────────────────────────────────────────────────────────────────────
const DEFAULT_AGENTS = [
  { id:'coder',      name:'Coder',      domain:'coding',   systemPrompt:'You are an expert software engineer. Write complete, working, tested code. No placeholders. Prefer simple solutions.', capabilities:['write_code','debug','refactor','review'] },
  { id:'researcher', name:'Researcher', domain:'research', systemPrompt:'You are a research analyst. Gather information, synthesize findings, cite sources. Be factual and comprehensive.', capabilities:['search','summarize','compare','cite'] },
  { id:'writer',     name:'Writer',     domain:'writing',  systemPrompt:"You are a direct, sharp editor and writer. Economy of language. Cut fluff. Match the user's register.", capabilities:['draft','edit','summarize','rewrite'] },
  { id:'analyst',    name:'Analyst',    domain:'data',     systemPrompt:'You are a data analyst. Precise with numbers and logic. Show your work. Flag assumptions.', capabilities:['analyze','calculate','visualize','model'] },
  { id:'critic',     name:'Critic',     domain:'review',   systemPrompt:'You are a critical reviewer. Identify flaws, gaps, and improvements. Be specific and constructive. Score 0-100.', capabilities:['critique','score','suggest','verify'] },
  { id:'planner',    name:'Planner',    domain:'planning', systemPrompt:'You are a project planner. Decompose goals into concrete steps. Identify dependencies. Estimate effort. Flag risks.', capabilities:['decompose','estimate','plan','prioritize'] },
];
function getAgents() {
  const saved = getDb().prepare('SELECT * FROM agents ORDER BY created_at DESC').all().map(a => ({ ...a, capabilities: parse(a.capabilities, []) }));
  const savedIds = new Set(saved.map(a => a.id));
  return [...saved, ...DEFAULT_AGENTS.filter(a => !savedIds.has(a.id))];
}
function upsertAgent({ id, name, domain, systemPrompt, capabilities = [], ephemeral = 0, spawnedFrom = null }) {
  getDb().prepare(`INSERT INTO agents(id,name,domain,system_prompt,capabilities,ephemeral,spawned_from,created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,domain=excluded.domain,
    system_prompt=excluded.system_prompt,capabilities=excluded.capabilities,ephemeral=excluded.ephemeral`
  ).run(id, name, domain||'general', systemPrompt, json(capabilities), ephemeral?1:0, spawnedFrom, now());
}
function deleteAgent(id) { getDb().prepare('DELETE FROM agents WHERE id=?').run(id); }

// ── Feedback ──────────────────────────────────────────────────────────────────
function addFeedback({ messageId, sessionId, rating, comment = '' }) {
  getDb().prepare('INSERT INTO feedback(id,message_id,session_id,rating,comment,ts) VALUES(?,?,?,?,?,?)').run(uid(), messageId||'', sessionId||'', rating, comment.slice(0,500), now());
}
function getFeedback(last = 50) {
  const fb = getDb().prepare('SELECT * FROM feedback ORDER BY ts DESC LIMIT ?').all(last);
  const total = getDb().prepare('SELECT COUNT(*) as n FROM feedback').get().n;
  const ups   = getDb().prepare("SELECT COUNT(*) as n FROM feedback WHERE rating='up'").get().n;
  return { feedback: fb, summary: { total, ups, downs: total-ups, satisfactionPct: total ? Math.round(ups/total*100) : null } };
}

// ── Revisions ─────────────────────────────────────────────────────────────────
function addRevision({ artifactId, content, type = 'code', sessionId = '' }) {
  const d = getDb();
  const ver = (d.prepare('SELECT COUNT(*) as n FROM revisions WHERE artifact_id=?').get(artifactId||'').n || 0) + 1;
  d.prepare('INSERT INTO revisions(id,artifact_id,content,type,version,session_id,ts) VALUES(?,?,?,?,?,?,?)').run(uid(), artifactId||uid(), content, type, ver, sessionId, now());
  return { artifactId, version: ver };
}
function getRevisions(artifactId) { return getDb().prepare('SELECT * FROM revisions WHERE artifact_id=? ORDER BY version DESC').all(artifactId); }

// ── Trajectories ──────────────────────────────────────────────────────────────
function addTrajectory({ taskId, steps, outcome }) {
  getDb().prepare('INSERT INTO trajectories(id,task_id,steps,outcome,step_count,ts) VALUES(?,?,?,?,?,?)').run(uid(), taskId||'', json(steps||[]), outcome||'unknown', (steps||[]).length, now());
}
function getTrajectories(limit=50) { return getDb().prepare('SELECT * FROM trajectories ORDER BY ts DESC LIMIT ?').all(limit).map(t=>({...t,steps:parse(t.steps,[])})); }

// ── A/B Tests ─────────────────────────────────────────────────────────────────
function getAbTests() {
  return getDb().prepare('SELECT * FROM ab_tests ORDER BY created_at DESC').all().map(t => ({
    ...t, variant_a: parse(t.variant_a, {}), variant_b: parse(t.variant_b, {}),
    results_a: parse(t.results_a, []), results_b: parse(t.results_b, [])
  }));
}
function addAbTest({ name, variantA, variantB, description }) {
  const id = uid();
  getDb().prepare('INSERT INTO ab_tests(id,name,variant_a,variant_b,description,active,results_a,results_b,created_at) VALUES(?,?,?,?,?,1,?,?,?)').run(id, name, json(variantA||{}), json(variantB||{}), description||'', '[]', '[]', now());
  return id;
}
function addAbTestResult(id, variant, quality, latency) {
  const d = getDb();
  const test = d.prepare('SELECT * FROM ab_tests WHERE id=?').get(id);
  if (!test) return false;
  const key = variant === 'A' ? 'results_a' : 'results_b';
  const results = parse(test[key], []);
  results.push({ quality, latency, ts: now() });
  d.prepare(`UPDATE ab_tests SET ${key}=? WHERE id=?`).run(json(results), id);
  return true;
}

// ── Eval Suites ───────────────────────────────────────────────────────────────
function getEvalSuites() { return getDb().prepare('SELECT * FROM eval_suites ORDER BY created_at DESC').all().map(s=>({...s,tests:parse(s.tests,[])})); }
function addEvalSuite({ name, tests }) {
  const id = uid();
  getDb().prepare('INSERT INTO eval_suites(id,name,tests,created_at) VALUES(?,?,?,?)').run(id, name, json((tests||[]).map(t=>({id:uid(),query:t.query,expectedKeywords:t.expectedKeywords||[],mustNotContain:t.mustNotContain||[],lastResult:null,lastRun:null}))), now());
  return id;
}
function updateEvalSuite(id, tests) { getDb().prepare('UPDATE eval_suites SET tests=? WHERE id=?').run(json(tests), id); }

// ── Task Queue ────────────────────────────────────────────────────────────────
function getTaskQueue() { return getDb().prepare('SELECT * FROM task_queue ORDER BY priority DESC, enqueued_at ASC').all(); }
function enqueueTask({ task, agentId, priority=5, sessionId }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO task_queue(id,task,agent_id,priority,session_id,status,enqueued_at) VALUES(?,?,?,?,?,?,?)').run(id, task, agentId||'', priority, sessionId||'', 'queued', ts);
  return id;
}
function updateTaskQueueItem(id, status) { getDb().prepare('UPDATE task_queue SET status=?,updated_at=? WHERE id=?').run(status, now(), id); }

// ── Agent Messages ────────────────────────────────────────────────────────────
function addAgentMessage({ senderId, recipientId, taskId, content, expectedFormat='text', priority='normal' }) {
  const id = uid();
  getDb().prepare('INSERT INTO agent_messages(id,sender_id,recipient_id,task_id,content,expected_format,priority,ts) VALUES(?,?,?,?,?,?,?,?)').run(id, senderId, recipientId, taskId||uid(), content, expectedFormat, priority, now());
  return id;
}
function getAgentMessages(agentId) {
  return getDb().prepare('SELECT * FROM agent_messages WHERE recipient_id=? OR sender_id=? ORDER BY ts DESC LIMIT 50').all(agentId, agentId);
}

// ── Improvements ──────────────────────────────────────────────────────────────
function addImprovement({ sessionId, aspect, correction }) {
  getDb().prepare('INSERT INTO improvements(session_id,aspect,correction,ts) VALUES(?,?,?,?)').run(sessionId||'', aspect||'content', correction.slice(0,200), now());
}
function getImprovements(limit=50) {
  const rows = getDb().prepare('SELECT * FROM improvements ORDER BY ts DESC LIMIT ?').all(limit);
  const summary = getDb().prepare('SELECT aspect, COUNT(*) as count FROM improvements GROUP BY aspect ORDER BY count DESC').all();
  return { total: getDb().prepare('SELECT COUNT(*) as n FROM improvements').get().n, patterns: summary, recent: rows };
}

// ── Prompt Versions ───────────────────────────────────────────────────────────
function addPromptVersion(version, hash, meta = {}) {
  getDb().prepare('INSERT INTO prompt_versions(version,hash,ts) VALUES(?,?,?)').run(version, hash, now());
}
function getPromptVersions(limit=100) { return getDb().prepare('SELECT * FROM prompt_versions ORDER BY ts DESC LIMIT ?').all(limit); }

// ─────────────────────────────────────────────────────────────────────────────
// v18 NEW FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ── Cost Tracking (Paperclip costService pattern) ─────────────────────────────
function recordCostEvent({ sessionId='', agentId='default', model='', provider='ollama', inputTokens=0, outputTokens=0, cachedInputTokens=0, costCents=0, billingCode='' }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO cost_events(id,session_id,agent_id,model,provider,input_tokens,output_tokens,cached_input_tokens,cost_cents,billing_code,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, sessionId, agentId, model, provider, inputTokens, outputTokens, cachedInputTokens, costCents, billingCode, ts, ts);
  // Update agent budget tracking
  try { getDb().prepare('UPDATE agent_budgets SET spent_monthly_cents=spent_monthly_cents+?,updated_at=? WHERE agent_id=?').run(costCents, ts, agentId); } catch(_) {}
  return { id, costCents };
}
function getCostSummary(sessionId=null, since=null) {
  const d = getDb();
  let q = 'SELECT SUM(cost_cents) as total_cents, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, SUM(cached_input_tokens) as cached_tokens, COUNT(*) as events FROM cost_events WHERE 1=1';
  const args = [];
  if (sessionId) { q += ' AND session_id=?'; args.push(sessionId); }
  if (since) { q += ' AND occurred_at>?'; args.push(since); }
  const row = d.prepare(q).get(...args);
  return { totalCents: row.total_cents||0, totalUsd: ((row.total_cents||0)/100).toFixed(4), inputTokens: row.input_tokens||0, outputTokens: row.output_tokens||0, cachedTokens: row.cached_tokens||0, events: row.events||0 };
}
function getCostByModel(since=null) {
  const d = getDb(); const args = [];
  let q = 'SELECT model, provider, SUM(cost_cents) as cost_cents, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, COUNT(*) as runs FROM cost_events WHERE 1=1';
  if (since) { q += ' AND occurred_at>?'; args.push(since); }
  return d.prepare(q + ' GROUP BY model, provider ORDER BY cost_cents DESC').all(...args);
}

// ── Agent Budget ──────────────────────────────────────────────────────────────
function getAgentBudget(agentId='default') {
  return getDb().prepare('SELECT * FROM agent_budgets WHERE agent_id=?').get(agentId) || { agent_id: agentId, budget_monthly_cents: 0, spent_monthly_cents: 0, status: 'active' };
}
function setAgentBudget(agentId, budgetMonthlyCents) {
  const ts = now(); const resetAt = new Date(); resetAt.setDate(1); resetAt.setHours(0,0,0,0);
  getDb().prepare('INSERT INTO agent_budgets(agent_id,budget_monthly_cents,spent_monthly_cents,budget_reset_at,status,updated_at) VALUES(?,?,0,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET budget_monthly_cents=?,updated_at=?').run(agentId, budgetMonthlyCents, resetAt.getTime(), 'active', ts, budgetMonthlyCents, ts);
}

// ── Heartbeat Runs (Paperclip heartbeat.ts pattern) ───────────────────────────
function createHeartbeatRun({ agentId='default', source='on_demand', triggerDetail='manual', sessionId='', contextSnapshot={} }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO heartbeat_runs(id,agent_id,invocation_source,trigger_detail,status,session_id,context_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, agentId, source, triggerDetail, 'queued', sessionId, JSON.stringify(contextSnapshot||{}), ts, ts);
  return id;
}
function startHeartbeatRun(runId) {
  getDb().prepare('UPDATE heartbeat_runs SET status=?,started_at=?,updated_at=? WHERE id=?').run('running', now(), now(), runId);
}
function finishHeartbeatRun(runId, { status='completed', exitCode=0, inputTokens=0, outputTokens=0, costCents=0, error='', stdoutExcerpt='', stderrExcerpt='', resultJson={} }={}) {
  const ts = now();
  getDb().prepare('UPDATE heartbeat_runs SET status=?,finished_at=?,exit_code=?,input_tokens=?,output_tokens=?,cost_cents=?,error=?,stdout_excerpt=?,stderr_excerpt=?,result_json=?,updated_at=? WHERE id=?').run(status, ts, exitCode, inputTokens, outputTokens, costCents, error||'', (stdoutExcerpt||'').slice(0,2000), (stderrExcerpt||'').slice(0,2000), JSON.stringify(resultJson||{}), ts, runId);
}
function addRunEvent(runId, { eventType='log', level='info', message='', meta={} }={}) {
  getDb().prepare('INSERT INTO heartbeat_run_events(run_id,event_type,level,message,meta,ts) VALUES(?,?,?,?,?,?)').run(runId, eventType, level, message.slice(0,4000), JSON.stringify(meta||{}), now());
}
function getHeartbeatRuns(agentId=null, limit=20) {
  const d = getDb();
  if (agentId) return d.prepare('SELECT * FROM heartbeat_runs WHERE agent_id=? ORDER BY created_at DESC LIMIT ?').all(agentId, limit);
  return d.prepare('SELECT * FROM heartbeat_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}
function getRunEvents(runId) {
  return getDb().prepare('SELECT * FROM heartbeat_run_events WHERE run_id=? ORDER BY ts ASC').all(runId);
}
function reapOrphanedRuns() {
  const d = getDb(); const ts = now(); const staleThreshold = ts - 15*60*1000;
  const stale = d.prepare("SELECT id,agent_id FROM heartbeat_runs WHERE status IN ('queued','running') AND created_at<?").all(staleThreshold);
  const reapStmt = d.prepare("UPDATE heartbeat_runs SET status='failed',error='Reaped by startup',finished_at=?,updated_at=? WHERE id=?");
  const orphanStmt = d.prepare('INSERT OR IGNORE INTO orphaned_runs(run_id,agent_id,detected_at,reaped,reaped_at) VALUES(?,?,?,1,?)');
  for (const r of stale) { reapStmt.run(ts, ts, r.id); orphanStmt.run(r.id, r.agent_id, ts, ts); }
  return stale.length;
}

// ── Wakeup Queue (Paperclip agentWakeupRequests pattern) ──────────────────────
function enqueueWakeup({ agentId='default', source='on_demand', reason='', payload={}, idempotencyKey='', requestedBy='user' }) {
  const id = uid(); const ts = now();
  try {
    getDb().prepare('INSERT INTO agent_wakeup_requests(id,agent_id,source,reason,payload,idempotency_key,requested_by,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, agentId, source, reason||'', JSON.stringify(payload||{}), idempotencyKey||'', requestedBy||'user', 'pending', ts);
    return { id, coalesced: false };
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      const existing = getDb().prepare('SELECT id FROM agent_wakeup_requests WHERE idempotency_key=?').get(idempotencyKey);
      return { id: existing?.id||id, coalesced: true };
    }
    throw e;
  }
}
function getPendingWakeups(agentId=null) {
  if (agentId) return getDb().prepare("SELECT * FROM agent_wakeup_requests WHERE agent_id=? AND status='pending' ORDER BY created_at ASC").all(agentId);
  return getDb().prepare("SELECT * FROM agent_wakeup_requests WHERE status='pending' ORDER BY created_at ASC").all();
}
function resolveWakeup(id, runId) {
  getDb().prepare("UPDATE agent_wakeup_requests SET status='processed',run_id=?,processed_at=? WHERE id=?").run(runId||'', now(), id);
}

// ── Activity Log v2 (Paperclip activity-log.ts pattern) ────────────────────────
const SECRET_KEY_RE = /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key)/i;
function sanitizeActivityDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const out = {};
  for (const [k,v] of Object.entries(details)) {
    if (SECRET_KEY_RE.test(k)) { out[k] = '***REDACTED***'; }
    else if (typeof v === 'string' && v.split('.').length === 3 && v.length > 40) { out[k] = '***REDACTED***'; } // JWT
    else { out[k] = v; }
  }
  return out;
}
function logActivityV2({ actorType='user', actorId='user', action, entityType='message', entityId='', agentId='', runId='', details={} }) {
  const sanitized = sanitizeActivityDetails(details);
  getDb().prepare('INSERT INTO activity_log_v2(actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id,details,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(actorType, actorId, action, entityType, entityId||'', agentId||'', runId||'', JSON.stringify(sanitized||{}), now());
}
function getActivityLogV2(limit=100, entityType=null) {
  const d = getDb();
  if (entityType) return d.prepare('SELECT * FROM activity_log_v2 WHERE entity_type=? ORDER BY created_at DESC LIMIT ?').all(entityType, limit);
  return d.prepare('SELECT * FROM activity_log_v2 ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ── Sidebar Badges (Paperclip sidebarBadgeService pattern) ────────────────────
function updateSidebarBadges() {
  const d = getDb();
  const approvalsPending = (d.prepare("SELECT COUNT(*) as n FROM approvals WHERE status='pending'").get().n)||0;
  const failedRuns = (d.prepare("SELECT COUNT(*) as n FROM heartbeat_runs WHERE status='failed' AND finished_at > ?").get(now()-24*60*60*1000).n)||0;
  const unreadIssues = (d.prepare("SELECT COUNT(*) as n FROM issues WHERE status='todo'").get().n)||0;
  const inbox = approvalsPending + failedRuns;
  const ts = now();
  d.prepare('UPDATE sidebar_badge_cache SET approvals_pending=?,failed_runs=?,unread_issues=?,inbox_total=?,updated_at=? WHERE id=1').run(approvalsPending, failedRuns, unreadIssues, inbox, ts);
  return { approvals: approvalsPending, failedRuns, unreadIssues, inbox };
}
function getSidebarBadges() {
  const cache = getDb().prepare('SELECT * FROM sidebar_badge_cache WHERE id=1').get();
  if (!cache || Date.now()-cache.updated_at > 30000) return updateSidebarBadges();
  return { approvals: cache.approvals_pending, failedRuns: cache.failed_runs, unreadIssues: cache.unread_issues, inbox: cache.inbox_total };
}

// ── Projects ──────────────────────────────────────────────────────────────────
function getProjects(status=null) {
  if (status) return getDb().prepare('SELECT * FROM projects WHERE status=? ORDER BY sort_order,created_at DESC').all(status);
  return getDb().prepare('SELECT * FROM projects ORDER BY sort_order,created_at DESC').all();
}
function upsertProject({ id, name, description='', workspaceId='', goalId='', status='active', sortOrder=0 }) {
  const ts = now(); const pid = id || uid();
  getDb().prepare('INSERT INTO projects(id,name,description,workspace_id,goal_id,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=?,description=?,status=?,sort_order=?,updated_at=?').run(pid, name, description, workspaceId, goalId, status, sortOrder, ts, ts, name, description, status, sortOrder, ts);
  return pid;
}
function deleteProject(id) { getDb().prepare('DELETE FROM projects WHERE id=?').run(id); }

// ── Goals ─────────────────────────────────────────────────────────────────────
function getGoals(projectId=null) {
  if (projectId) return getDb().prepare('SELECT * FROM goals WHERE project_id=? ORDER BY created_at DESC').all(projectId);
  return getDb().prepare('SELECT * FROM goals ORDER BY created_at DESC').all();
}
function upsertGoal({ id, title, description='', parentGoalId='', projectId='', status='active', priority='normal', dueDate=null }) {
  const ts = now(); const gid = id || uid();
  getDb().prepare('INSERT INTO goals(id,title,description,parent_goal_id,project_id,status,priority,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=?,description=?,status=?,priority=?,due_date=?,updated_at=?').run(gid, title, description, parentGoalId||'', projectId||'', status, priority, dueDate, ts, ts, title, description, status, priority, dueDate, ts);
  return gid;
}
function deleteGoal(id) { getDb().prepare('DELETE FROM goals WHERE id=?').run(id); }

// ── Issues / Kanban ───────────────────────────────────────────────────────────
function getIssues(projectId=null, status=null) {
  const d = getDb(); const args = [];
  let q = 'SELECT * FROM issues WHERE 1=1';
  if (projectId) { q += ' AND project_id=?'; args.push(projectId); }
  if (status) { q += ' AND status=?'; args.push(status); }
  return d.prepare(q + ' ORDER BY sort_order,created_at DESC').all(...args);
}
function upsertIssue({ id, title, description='', projectId='', assigneeAgentId='', status='todo', priority='normal', labels=[], sortOrder=0 }) {
  const ts = now(); const iid = id || uid();
  getDb().prepare('INSERT INTO issues(id,title,description,project_id,assignee_agent_id,status,priority,labels,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=?,description=?,status=?,priority=?,assignee_agent_id=?,sort_order=?,labels=?,updated_at=?').run(iid, title, description, projectId, assigneeAgentId||'', status, priority, JSON.stringify(labels||[]), sortOrder, ts, ts, title, description, status, priority, assigneeAgentId||'', sortOrder, JSON.stringify(labels||[]), ts);
  return iid;
}
function deleteIssue(id) { getDb().prepare('DELETE FROM issues WHERE id=?').run(id); }
function addIssueComment({ issueId, authorType='user', authorId='user', content }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO issue_comments(id,issue_id,author_type,author_id,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, issueId, authorType, authorId, content, ts, ts);
  return id;
}
function getIssueComments(issueId) { return getDb().prepare('SELECT * FROM issue_comments WHERE issue_id=? ORDER BY created_at ASC').all(issueId); }

// ── Conversation Branches ─────────────────────────────────────────────────────
function branchConversation(parentId, branchAtIndex, messages=[], name='Branch') {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO conversation_branches(id,parent_conversation_id,branch_at_message_index,messages,name,created_at) VALUES(?,?,?,?,?,?)').run(id, parentId, branchAtIndex, JSON.stringify(messages||[]), name, ts);
  try { getDb().prepare('UPDATE conversations SET branch_count=branch_count+1 WHERE id=?').run(parentId); } catch(_) {}
  return id;
}
function getConversationBranches(parentId) {
  return getDb().prepare('SELECT * FROM conversation_branches WHERE parent_conversation_id=? ORDER BY created_at DESC').all(parentId);
}

// ── Pinned Messages ───────────────────────────────────────────────────────────
function pinMessage({ conversationId, messageIndex, contentPreview='' }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT OR REPLACE INTO pinned_messages(id,conversation_id,message_index,content_preview,pinned_by,created_at) VALUES(?,?,?,?,?,?)').run(id, conversationId, messageIndex, contentPreview.slice(0,200), 'user', ts);
  return id;
}
function unpinMessage(conversationId, messageIndex) {
  getDb().prepare('DELETE FROM pinned_messages WHERE conversation_id=? AND message_index=?').run(conversationId, messageIndex);
}
function getPinnedMessages(conversationId) {
  return getDb().prepare('SELECT * FROM pinned_messages WHERE conversation_id=? ORDER BY message_index ASC').all(conversationId);
}

// ── Message Reactions ─────────────────────────────────────────────────────────
function addReaction(conversationId, messageIndex, emoji) {
  const id = uid(); const ts = now();
  try {
    getDb().prepare('INSERT INTO message_reactions(id,conversation_id,message_index,emoji,count,created_at) VALUES(?,?,?,?,1,?)').run(id, conversationId, messageIndex, emoji, ts);
  } catch(_) {
    getDb().prepare('UPDATE message_reactions SET count=count+1 WHERE conversation_id=? AND message_index=? AND emoji=?').run(conversationId, messageIndex, emoji);
  }
}
function getReactions(conversationId, messageIndex) {
  return getDb().prepare('SELECT emoji,count FROM message_reactions WHERE conversation_id=? AND message_index=?').all(conversationId, messageIndex);
}

// ── Search History ────────────────────────────────────────────────────────────
function addSearchHistory(query, resultCount=0, searchType='rag') {
  getDb().prepare('INSERT INTO search_history(query,result_count,search_type,ts) VALUES(?,?,?,?)').run(query.slice(0,500), resultCount, searchType, now());
}
function getSearchHistory(limit=50) { return getDb().prepare('SELECT * FROM search_history ORDER BY ts DESC LIMIT ?').all(limit); }
function clearSearchHistory() { getDb().prepare('DELETE FROM search_history').run(); }

// ── Clipboard History ─────────────────────────────────────────────────────────
function addClipboardEntry(content, contentType='text', source='manual') {
  if (!content || content.length > 50000) return;
  getDb().prepare('INSERT INTO clipboard_history(content,content_type,source,ts) VALUES(?,?,?,?)').run(content.slice(0,50000), contentType, source, now());
  // Keep max 100 entries
  getDb().prepare('DELETE FROM clipboard_history WHERE id NOT IN (SELECT id FROM clipboard_history ORDER BY ts DESC LIMIT 100)').run();
}
function getClipboardHistory(limit=50) { return getDb().prepare('SELECT * FROM clipboard_history ORDER BY ts DESC LIMIT ?').all(limit); }
function clearClipboardHistory() { getDb().prepare('DELETE FROM clipboard_history').run(); }

// ── Feature Flags ─────────────────────────────────────────────────────────────
function getFeatureFlag(flag) {
  const row = getDb().prepare('SELECT * FROM feature_flags WHERE flag=?').get(flag);
  return row ? !!row.enabled : false;
}
function getAllFeatureFlags() { return getDb().prepare('SELECT * FROM feature_flags ORDER BY flag').all(); }
function setFeatureFlag(flag, enabled, description='') {
  getDb().prepare('INSERT INTO feature_flags(flag,enabled,description,updated_at) VALUES(?,?,?,?) ON CONFLICT(flag) DO UPDATE SET enabled=?,updated_at=?').run(flag, enabled?1:0, description, now(), enabled?1:0, now());
}

// ── Prompt Library ────────────────────────────────────────────────────────────
function getPromptLibrary(category=null) {
  if (category) return getDb().prepare('SELECT * FROM prompt_library WHERE category=? ORDER BY use_count DESC,created_at DESC').all(category);
  return getDb().prepare('SELECT * FROM prompt_library ORDER BY use_count DESC,created_at DESC').all();
}
function addPromptToLibrary({ title, content, category='general', tags=[] }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO prompt_library(id,title,content,category,tags,use_count,is_system,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?)').run(id, title, content, category, JSON.stringify(tags||[]), ts, ts);
  return id;
}
function usePromptLibraryEntry(id) {
  getDb().prepare('UPDATE prompt_library SET use_count=use_count+1,updated_at=? WHERE id=?').run(now(), id);
}
function deletePromptLibraryEntry(id) { getDb().prepare('DELETE FROM prompt_library WHERE id=? AND is_system=0').run(id); }

// ── Workspaces ────────────────────────────────────────────────────────────────
function getWorkspaces() { return getDb().prepare('SELECT * FROM workspaces ORDER BY is_primary DESC,created_at DESC').all(); }
function upsertWorkspace({ id, name, cwd, repoUrl='', repoRef='main', description='', isPrimary=0 }) {
  const ts = now(); const wid = id || uid();
  getDb().prepare('INSERT INTO workspaces(id,name,cwd,repo_url,repo_ref,description,is_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=?,cwd=?,repo_url=?,repo_ref=?,description=?,is_primary=?,updated_at=?').run(wid, name, cwd, repoUrl, repoRef, description, isPrimary?1:0, ts, ts, name, cwd, repoUrl, repoRef, description, isPrimary?1:0, ts);
  return wid;
}
function deleteWorkspace(id) { getDb().prepare('DELETE FROM workspaces WHERE id=?').run(id); }

// ── Notifications ─────────────────────────────────────────────────────────────
function addNotification({ type, title, message='', data={} }) {
  const id = uid();
  getDb().prepare('INSERT INTO notifications(id,type,title,message,data,read,created_at) VALUES(?,?,?,?,?,0,?)').run(id, type, title, message, JSON.stringify(data||{}), now());
  // Keep max 200
  getDb().prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT 200)').run();
  return id;
}
function getNotifications(unreadOnly=false) {
  if (unreadOnly) return getDb().prepare('SELECT * FROM notifications WHERE read=0 ORDER BY created_at DESC').all();
  return getDb().prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
}
function markNotificationRead(id) {
  if (id === 'all') getDb().prepare('UPDATE notifications SET read=1').run();
  else getDb().prepare('UPDATE notifications SET read=1 WHERE id=?').run(id);
}
function getUnreadNotificationCount() { return (getDb().prepare('SELECT COUNT(*) as n FROM notifications WHERE read=0').get().n)||0; }

// ── Tool Usage Stats ──────────────────────────────────────────────────────────
function recordToolUsage(tool, success=true, latencyMs=0) {
  const ts = now(); const d = getDb();
  const successInc = success ? 1 : 0; const failInc = success ? 0 : 1;
  try {
    d.prepare('INSERT INTO tool_usage_stats(tool,call_count,success_count,fail_count,total_latency_ms,last_used,updated_at) VALUES(?,1,?,?,?,?,?) ON CONFLICT(tool) DO UPDATE SET call_count=call_count+1,success_count=success_count+?,fail_count=fail_count+?,total_latency_ms=total_latency_ms+?,last_used=?,updated_at=?').run(tool, successInc, failInc, latencyMs, ts, ts, successInc, failInc, latencyMs, ts, ts);
  } catch(_) {}
}
function getToolStats() { return getDb().prepare('SELECT *, CAST(total_latency_ms AS REAL)/NULLIF(call_count,0) as avg_latency_ms FROM tool_usage_stats ORDER BY call_count DESC').all(); }

// ── Webhooks ──────────────────────────────────────────────────────────────────
function getWebhooks() { return getDb().prepare('SELECT * FROM webhooks WHERE enabled=1 ORDER BY created_at DESC').all(); }
function addWebhook({ url, events=[], secret='' }) {
  const id = uid(); const ts = now();
  getDb().prepare('INSERT INTO webhooks(id,url,events,secret,enabled,fail_count,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?)').run(id, url, JSON.stringify(events||[]), secret, ts, ts);
  return id;
}
function updateWebhookFailCount(id, increment=true) {
  if (increment) getDb().prepare('UPDATE webhooks SET fail_count=fail_count+1,updated_at=? WHERE id=?').run(now(), id);
  else getDb().prepare('UPDATE webhooks SET fail_count=0,last_triggered=?,updated_at=? WHERE id=?').run(now(), now(), id);
}
function deleteWebhook(id) { getDb().prepare('DELETE FROM webhooks WHERE id=?').run(id); }

// ── Scheduled Tasks ───────────────────────────────────────────────────────────
function getScheduledTasks() { return getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC').all(); }
function getDueScheduledTasks() { return getDb().prepare('SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at ASC').all(now()); }
function upsertScheduledTask({ id, name, cron='', nextRunAt, action, payload={}, enabled=1 }) {
  const ts = now(); const sid = id || uid();
  getDb().prepare('INSERT INTO scheduled_tasks(id,name,cron,next_run_at,action,payload,enabled,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=?,cron=?,next_run_at=?,action=?,payload=?,enabled=?,created_at=coalesce(created_at,?)').run(sid, name, cron, nextRunAt, action, JSON.stringify(payload||{}), enabled?1:0, ts, name, cron, nextRunAt, action, JSON.stringify(payload||{}), enabled?1:0, ts);
  return sid;
}
function updateScheduledTaskRun(id, status, nextRunAt=null) {
  if (nextRunAt) getDb().prepare('UPDATE scheduled_tasks SET last_run_at=?,last_status=?,next_run_at=? WHERE id=?').run(now(), status, nextRunAt, id);
  else getDb().prepare('UPDATE scheduled_tasks SET last_run_at=?,last_status=? WHERE id=?').run(now(), status, id);
}

// ── Model Personas ────────────────────────────────────────────────────────────
function getModelPersonas() { return getDb().prepare('SELECT * FROM model_personas ORDER BY is_default DESC,created_at DESC').all(); }
function upsertModelPersona({ id, name, description='', systemPrompt, avatarEmoji='🤖', isDefault=0 }) {
  const ts = now(); const mid = id || uid();
  if (isDefault) getDb().prepare('UPDATE model_personas SET is_default=0').run();
  getDb().prepare('INSERT INTO model_personas(id,name,description,system_prompt,avatar_emoji,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=?,description=?,system_prompt=?,avatar_emoji=?,is_default=?,updated_at=?').run(mid, name, description, systemPrompt, avatarEmoji, isDefault?1:0, ts, ts, name, description, systemPrompt, avatarEmoji, isDefault?1:0, ts);
  return mid;
}
function deleteModelPersona(id) { getDb().prepare('DELETE FROM model_personas WHERE id=?').run(id); }

// ── Conversation Tags ─────────────────────────────────────────────────────────
function addConversationTag(conversationId, tag) {
  try { getDb().prepare('INSERT OR IGNORE INTO conversation_tags(conversation_id,tag,created_at) VALUES(?,?,?)').run(conversationId, tag.slice(0,50), now()); }
  catch(_) {}
}
function removeConversationTag(conversationId, tag) { getDb().prepare('DELETE FROM conversation_tags WHERE conversation_id=? AND tag=?').run(conversationId, tag); }
function getConversationsByTag(tag) {
  return getDb().prepare('SELECT c.* FROM conversations c INNER JOIN conversation_tags t ON c.id=t.conversation_id WHERE t.tag=? ORDER BY c.updated_at DESC').all(tag);
}
function getAllTags() { return getDb().prepare('SELECT tag, COUNT(*) as count FROM conversation_tags GROUP BY tag ORDER BY count DESC').all(); }

// ── Request Traces ────────────────────────────────────────────────────────────
function addRequestTrace({ method, path, statusCode, latencyMs, ip='', userAgent='' }) {
  if (!getFeatureFlag('request_tracing')) return;
  getDb().prepare('INSERT INTO request_traces(id,method,path,status_code,latency_ms,ip,user_agent,ts) VALUES(?,?,?,?,?,?,?,?)').run(uid(), method, path, statusCode, latencyMs, ip.slice(0,45), (userAgent||'').slice(0,200), now());
  // Keep last 10k traces
  try { getDb().prepare('DELETE FROM request_traces WHERE ts < (SELECT ts FROM request_traces ORDER BY ts DESC LIMIT 1 OFFSET 10000)').run(); } catch(_) {}
}
function getRequestTraces(limit=100) { return getDb().prepare('SELECT * FROM request_traces ORDER BY ts DESC LIMIT ?').all(limit); }

// ── Code Diffs ────────────────────────────────────────────────────────────────
function addCodeDiff({ sessionId='', filename, beforeHash='', afterHash='', patch }) {
  const id = uid();
  getDb().prepare('INSERT INTO code_diffs(id,session_id,filename,before_hash,after_hash,patch,applied,created_at) VALUES(?,?,?,?,?,?,0,?)').run(id, sessionId, filename, beforeHash, afterHash, patch.slice(0,100000), now());
  return id;
}
function getCodeDiffs(sessionId=null, limit=50) {
  if (sessionId) return getDb().prepare('SELECT * FROM code_diffs WHERE session_id=? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit);
  return getDb().prepare('SELECT * FROM code_diffs ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ── Model Comparisons ─────────────────────────────────────────────────────────
function addModelComparison({ prompt, results=[] }) {
  const id = uid();
  getDb().prepare('INSERT INTO model_comparisons(id,prompt,results,created_at) VALUES(?,?,?,?)').run(id, prompt.slice(0,5000), JSON.stringify(results), now());
  return id;
}
function getModelComparisons(limit=20) {
  return getDb().prepare('SELECT * FROM model_comparisons ORDER BY created_at DESC LIMIT ?').all(limit).map(r => ({ ...r, results: JSON.parse(r.results||'[]') }));
}

// ── API Keys (external REST access) ───────────────────────────────────────────
function createApiKey(name, permissions=['read']) {
  const raw = crypto.randomBytes(32).toString('hex');
  const prefix = raw.slice(0,8);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const id = uid();
  getDb().prepare('INSERT INTO api_keys(id,name,key_hash,key_prefix,permissions,created_at) VALUES(?,?,?,?,?,?)').run(id, name, hash, prefix, JSON.stringify(permissions), now());
  return { id, key: `sk_${raw}`, prefix, permissions };
}
function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('sk_')) return null;
  const hash = crypto.createHash('sha256').update(rawKey.slice(3)).digest('hex');
  const row = getDb().prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hash);
  if (!row) return null;
  if (row.expires_at && Date.now() > row.expires_at) return null;
  getDb().prepare('UPDATE api_keys SET last_used=? WHERE id=?').run(now(), row.id);
  return { id: row.id, name: row.name, permissions: JSON.parse(row.permissions||'["read"]') };
}
function listApiKeys() { return getDb().prepare('SELECT id,name,key_prefix,permissions,last_used,created_at,expires_at FROM api_keys').all(); }
function deleteApiKey(id) { getDb().prepare('DELETE FROM api_keys WHERE id=?').run(id); }

// ── Memory Consolidation ──────────────────────────────────────────────────────
function logMemoryConsolidation({ trigger='scheduled', entriesBefore=0, entriesAfter=0, summary='' }) {
  getDb().prepare('INSERT INTO memory_consolidations(trigger,entries_before,entries_after,summary,ts) VALUES(?,?,?,?,?)').run(trigger, entriesBefore, entriesAfter, summary.slice(0,2000), now());
}
function getMemoryConsolidations(limit=20) { return getDb().prepare('SELECT * FROM memory_consolidations ORDER BY ts DESC LIMIT ?').all(limit); }

// ── Task Sessions ─────────────────────────────────────────────────────────────
function getTaskSession(agentId, taskKey) {
  return getDb().prepare('SELECT * FROM agent_task_sessions WHERE agent_id=? AND task_key=?').get(agentId, taskKey);
}
function upsertTaskSession({ agentId='default', taskKey, sessionParams={}, workspaceCwd='', workspaceSource='agent_home' }) {
  const ts = now(); const id = uid();
  getDb().prepare('INSERT INTO agent_task_sessions(id,agent_id,task_key,session_params,workspace_cwd,workspace_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,task_key) DO UPDATE SET session_params=?,workspace_cwd=?,workspace_source=?,updated_at=?').run(id, agentId, taskKey, JSON.stringify(sessionParams||{}), workspaceCwd, workspaceSource, ts, ts, JSON.stringify(sessionParams||{}), workspaceCwd, workspaceSource, ts);
}

// ── Session Continuity ────────────────────────────────────────────────────────
function getSessionContinuity(sessionId) {
  return getDb().prepare('SELECT * FROM session_continuity WHERE session_id=?').get(sessionId);
}
function upsertSessionContinuity(sessionId, { continuityPrompt='', lastDomain='', lastModel='', messageCount=0 }) {
  getDb().prepare('INSERT INTO session_continuity(session_id,continuity_prompt,last_domain,last_model,message_count,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET continuity_prompt=?,last_domain=?,last_model=?,message_count=?,updated_at=?').run(sessionId, continuityPrompt, lastDomain, lastModel, messageCount, now(), continuityPrompt, lastDomain, lastModel, messageCount, now());
}

// ── Backup ────────────────────────────────────────────────────────────────────
function logBackup({ id, backupPath, sizeBytes=0, tablesIncluded=[] }) {
  getDb().prepare('INSERT OR REPLACE INTO backup_manifest(id,backup_path,size_bytes,tables_included,created_at,verified) VALUES(?,?,?,?,?,0)').run(id||uid(), backupPath, sizeBytes, JSON.stringify(tablesIncluded), now());
}
function getBackupManifest() { return getDb().prepare('SELECT * FROM backup_manifest ORDER BY created_at DESC LIMIT 50').all(); }

// ── Incognito Sessions ────────────────────────────────────────────────────────
function startIncognitoSession(sessionId) {
  getDb().prepare('INSERT OR IGNORE INTO incognito_sessions(session_id,started_at,message_count) VALUES(?,?,0)').run(sessionId, now());
}
function isIncognitoSession(sessionId) {
  if (!sessionId) return false;
  const row = getDb().prepare('SELECT * FROM incognito_sessions WHERE session_id=? AND ended_at IS NULL').get(sessionId);
  return !!row;
}
function endIncognitoSession(sessionId) {
  getDb().prepare('UPDATE incognito_sessions SET ended_at=? WHERE session_id=?').run(now(), sessionId);
}


module.exports = {
  getDb, auditLog, logError, getErrors, clearErrors, getAuditLog,
  // Conversations
  listConversations, getConversation, upsertConversation, deleteConversation,
  patchConversation, searchConversations, bulkDeleteConversations, exportConversation, duplicateConversation,
  // Memory
  storeMemory, loadMemory, retrieveRelevantMemory, applyMemoryDecay, MEMORY_NAMESPACES,
  // Notes
  getNotes, addNote, patchNote, deleteNote, clearNotes,
  // Tasks
  getTasks, addTask, patchTask, deleteTask,
  // Docs
  getDocs, getDocWithChunks, upsertDoc, deleteDoc, getAllChunks,
  // Plans
  getPlans, getPlan, upsertPlan, deletePlan,
  // Metrics
  recordMetric, getMetrics, getMetricsSummary,
  // Approvals
  addApproval, getApproval, getApprovals, resolveApproval,
  // Secrets
  getSecrets, setSecret, deleteSecret,
  // Prefs
  getPrefs, setPrefs,
  // Agent memory
  getAgentMemory, setAgentMemory, deleteAgentMemory,
  // Templates
  getTemplates, addTemplate, deleteTemplate,
  // Sessions
  getSession, setSession, pruneIdleSessions,
  // KV
  kvGet, kvSet, kvDelete,
  // Agents
  getAgents, upsertAgent, deleteAgent, DEFAULT_AGENTS,
  // Feedback
  addFeedback, getFeedback,
  // Revisions
  addRevision, getRevisions,
  // Trajectories
  addTrajectory, getTrajectories,
  // A/B Tests
  getAbTests, addAbTest, addAbTestResult,
  // Eval Suites
  getEvalSuites, addEvalSuite, updateEvalSuite,
  // Task Queue
  getTaskQueue, enqueueTask, updateTaskQueueItem,
  // Agent Messages
  addAgentMessage, getAgentMessages,
  // Improvements
  addImprovement, getImprovements,
  // Prompt Versions
  addPromptVersion, getPromptVersions,
  // ── v18 NEW ──────────────────────────────────────────────────────────────
  // Cost Tracking
  recordCostEvent, getCostSummary, getCostByModel,
  // Agent Budget
  getAgentBudget, setAgentBudget,
  // Heartbeat Runs
  createHeartbeatRun, startHeartbeatRun, finishHeartbeatRun, addRunEvent,
  getHeartbeatRuns, getRunEvents, reapOrphanedRuns,
  // Wakeup Queue
  enqueueWakeup, getPendingWakeups, resolveWakeup,
  // Activity Log v2
  logActivityV2, getActivityLogV2, sanitizeActivityDetails,
  // Sidebar Badges
  getSidebarBadges, updateSidebarBadges,
  // Projects
  getProjects, upsertProject, deleteProject,
  // Goals
  getGoals, upsertGoal, deleteGoal,
  // Issues / Kanban
  getIssues, upsertIssue, deleteIssue, addIssueComment, getIssueComments,
  // Conversation Branches
  branchConversation, getConversationBranches,
  // Pinned Messages
  pinMessage, unpinMessage, getPinnedMessages,
  // Message Reactions
  addReaction, getReactions,
  // Search History
  addSearchHistory, getSearchHistory, clearSearchHistory,
  // Clipboard
  addClipboardEntry, getClipboardHistory, clearClipboardHistory,
  // Feature Flags
  getFeatureFlag, getAllFeatureFlags, setFeatureFlag,
  // Prompt Library
  getPromptLibrary, addPromptToLibrary, usePromptLibraryEntry, deletePromptLibraryEntry,
  // Workspaces
  getWorkspaces, upsertWorkspace, deleteWorkspace,
  // Notifications
  addNotification, getNotifications, markNotificationRead, getUnreadNotificationCount,
  // Tool Stats
  recordToolUsage, getToolStats,
  // Webhooks
  getWebhooks, addWebhook, updateWebhookFailCount, deleteWebhook,
  // Scheduled Tasks
  getScheduledTasks, getDueScheduledTasks, upsertScheduledTask, updateScheduledTaskRun,
  // Model Personas
  getModelPersonas, upsertModelPersona, deleteModelPersona,
  // Conversation Tags
  addConversationTag, removeConversationTag, getConversationsByTag, getAllTags,
  // Request Traces
  addRequestTrace, getRequestTraces,
  // Code Diffs
  addCodeDiff, getCodeDiffs,
  // Model Comparisons
  addModelComparison, getModelComparisons,
  // API Keys
  createApiKey, validateApiKey, listApiKeys, deleteApiKey,
  // Memory Consolidation
  logMemoryConsolidation, getMemoryConsolidations,
  // Task Sessions
  getTaskSession, upsertTaskSession,
  // Session Continuity
  getSessionContinuity, upsertSessionContinuity,
  // Backup
  logBackup, getBackupManifest,
  // Incognito
  startIncognitoSession, isIncognitoSession, endIncognitoSession,
  // Utils
  now, uid: () => require('crypto').randomUUID(),
};

// Lazy require to avoid circular reference
function cosineSim(a, b) {
  const SW = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','to','of','in','on','at','by','for','with','about','as','into','through','before','after','each','this','that','these','those','i','you','he','she','it','we','they','and','or','but','not','so','if','then','than','when','where','who','what','how','all','any','both','few','more','most','other','some','such','no','nor','only','same','too','very','just','while','our','their','its','my','your','his','her','which','there','here','from','up','out']);
  const tok = t => t.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>1&&!SW.has(w));
  const ta = new Set(tok(a||'')), tb = new Set(tok(b||''));
  const inter = [...ta].filter(t=>tb.has(t)).length;
  if (!ta.size || !tb.size) return 0;
  return inter / Math.sqrt(ta.size * tb.size);
}
