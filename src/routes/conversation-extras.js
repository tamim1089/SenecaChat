'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db/index');
const u = require('../utils/index');

const router = express.Router();

// ── CONVERSATION BRANCHES ─────────────────────────────────────────────────────
router.post('/conversations/:id/branch', (req, res) => {
  const { branchAtIndex=0, messages=[], name='Branch' } = req.body;
  try {
    const branchId = db.branchConversation(req.params.id, branchAtIndex, messages, name);
    db.logActivityV2({ actorType:'user', actorId:'user', action:'conversation.branched', entityType:'conversation', entityId:req.params.id, details:{ branchId, branchAtIndex } });
    res.json({ ok:true, branchId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/conversations/:id/branches', (req, res) => {
  res.json(db.getConversationBranches(req.params.id));
});

// ── PINNED MESSAGES ───────────────────────────────────────────────────────────
router.get('/conversations/:id/pins', (req, res) => {
  res.json(db.getPinnedMessages(req.params.id));
});
router.post('/conversations/:id/pins', (req, res) => {
  const { messageIndex, contentPreview='' } = req.body;
  if (typeof messageIndex !== 'number') return res.status(400).json({ error: 'messageIndex required' });
  const pinId = db.pinMessage({ conversationId: req.params.id, messageIndex, contentPreview });
  res.json({ ok:true, pinId });
});
router.delete('/conversations/:id/pins/:index', (req, res) => {
  db.unpinMessage(req.params.id, parseInt(req.params.index));
  res.json({ ok:true });
});

// ── MESSAGE REACTIONS ─────────────────────────────────────────────────────────
router.get('/conversations/:id/messages/:index/reactions', (req, res) => {
  res.json(db.getReactions(req.params.id, parseInt(req.params.index)));
});
router.post('/conversations/:id/messages/:index/reactions', (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  db.addReaction(req.params.id, parseInt(req.params.index), emoji);
  res.json({ ok:true });
});

// ── CONVERSATION TAGS ─────────────────────────────────────────────────────────
router.get('/conversations/:id/tags', (req, res) => {
  const tags = db.getDb().prepare('SELECT tag FROM conversation_tags WHERE conversation_id=?').all(req.params.id);
  res.json(tags.map(t => t.tag));
});
router.post('/conversations/:id/tags', (req, res) => {
  const { tag } = req.body;
  if (!u.validateStr(tag||'', 50)) return res.status(400).json({ error: 'INVALID_TAG' });
  db.addConversationTag(req.params.id, tag);
  res.json({ ok:true });
});
router.delete('/conversations/:id/tags/:tag', (req, res) => {
  db.removeConversationTag(req.params.id, req.params.tag);
  res.json({ ok:true });
});
router.get('/tags', (req, res) => {
  res.json(db.getAllTags());
});
router.get('/tags/:tag/conversations', (req, res) => {
  res.json(db.getConversationsByTag(req.params.tag));
});

// ── SEARCH HISTORY ────────────────────────────────────────────────────────────
router.get('/search-history', (req, res) => {
  res.json(db.getSearchHistory(parseInt(req.query.limit)||50));
});
router.delete('/search-history', (req, res) => {
  db.clearSearchHistory();
  res.json({ ok:true });
});

// ── CLIPBOARD ─────────────────────────────────────────────────────────────────
router.get('/clipboard', (req, res) => {
  res.json(db.getClipboardHistory(parseInt(req.query.limit)||50));
});
router.post('/clipboard', (req, res) => {
  const { content, contentType='text', source='manual' } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  db.addClipboardEntry(content, contentType, source);
  res.json({ ok:true });
});
router.delete('/clipboard', (req, res) => {
  db.clearClipboardHistory();
  res.json({ ok:true });
});

// ── CONVERSATION EXPORT (enhanced — JSON + Markdown + PDF-ready HTML) ─────────
router.get('/conversations/:id/export/json', (req, res) => {
  const conv = db.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'NOT_FOUND' });
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition', `attachment; filename="chat-${conv.id.slice(0,8)}.json"`);
  res.send(JSON.stringify({ exportedAt: new Date().toISOString(), version: '18', ...conv }, null, 2));
});
router.get('/conversations/:id/export/html', (req, res) => {
  const conv = db.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'NOT_FOUND' });
  const messages = JSON.parse(conv.messages||'[]');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${conv.name||'Chat'}</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:20px;}.user{background:#f0f0f0;padding:10px;margin:8px 0;border-radius:8px;}.assistant{background:#e8f4fd;padding:10px;margin:8px 0;border-radius:8px;}h3{color:#555;font-size:0.8em;margin:0 0 4px}</style></head><body><h1>${conv.name||'Chat'}</h1><p><small>Exported ${new Date().toISOString()}</small></p>${messages.map(m=>`<div class="${m.role}"><h3>${m.role}</h3><p>${(m.content||'').replace(/</g,'&lt;')}</p></div>`).join('')}</body></html>`;
  res.setHeader('Content-Type','text/html');
  res.setHeader('Content-Disposition', `attachment; filename="chat-${conv.id.slice(0,8)}.html"`);
  res.send(html);
});

// ── MODEL COMPARISONS ─────────────────────────────────────────────────────────
router.get('/comparisons', (req, res) => {
  res.json(db.getModelComparisons(parseInt(req.query.limit)||20));
});
router.post('/comparisons', (req, res) => {
  const { prompt, results=[] } = req.body;
  if (!u.validateStr(prompt||'', 5000)) return res.status(400).json({ error: 'INVALID' });
  const id = db.addModelComparison({ prompt, results });
  res.json({ ok:true, id });
});

// ── PROMPT LIBRARY ────────────────────────────────────────────────────────────
router.get('/prompt-library', (req, res) => {
  res.json(db.getPromptLibrary(req.query.category||null));
});
router.post('/prompt-library', (req, res) => {
  const { title, content, category='general', tags=[] } = req.body;
  if (!u.validateStr(title||'', 200) || !u.validateStr(content||'', 20000)) return res.status(400).json({ error: 'INVALID' });
  const id = db.addPromptToLibrary({ title, content, category, tags });
  res.json({ ok:true, id });
});
router.post('/prompt-library/:id/use', (req, res) => {
  db.usePromptLibraryEntry(req.params.id);
  const entry = db.getPromptLibrary().find(p => p.id === req.params.id);
  res.json({ ok:true, content: entry?.content||'' });
});
router.delete('/prompt-library/:id', (req, res) => {
  db.deletePromptLibraryEntry(req.params.id);
  res.json({ ok:true });
});

module.exports = router;
