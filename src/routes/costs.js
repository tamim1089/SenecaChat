'use strict';
const express = require('express');
const db = require('../db/index');
const u = require('../utils/index');

const router = express.Router();

// POST /api/costs/event — record a cost event (called after each chat turn)
router.post('/event', (req, res) => {
  try {
    const { sessionId='', agentId='default', model='', provider='ollama', inputTokens=0, outputTokens=0, cachedInputTokens=0, costCents=0, billingCode='' } = req.body;
    const event = db.recordCostEvent({ sessionId, agentId, model, provider, inputTokens, outputTokens, cachedInputTokens, costCents, billingCode });
    db.logActivityV2({ actorType:'system', actorId:'cost_tracker', action:'cost.recorded', entityType:'cost_event', entityId:event.id, details:{ model, costCents, inputTokens, outputTokens } });
    res.json({ ok:true, ...event });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/costs/summary?sessionId=&since=
router.get('/summary', (req, res) => {
  const { sessionId, since } = req.query;
  res.json(db.getCostSummary(sessionId||null, since ? parseInt(since) : null));
});

// GET /api/costs/by-model?since=
router.get('/by-model', (req, res) => {
  const { since } = req.query;
  res.json(db.getCostByModel(since ? parseInt(since) : null));
});

// GET /api/costs/budget/:agentId
router.get('/budget/:agentId', (req, res) => {
  res.json(db.getAgentBudget(req.params.agentId));
});

// POST /api/costs/budget/:agentId
router.post('/budget/:agentId', (req, res) => {
  const { budgetMonthlyCents=0 } = req.body;
  db.setAgentBudget(req.params.agentId, budgetMonthlyCents);
  db.logActivityV2({ actorType:'user', actorId:'user', action:'agent.budget_updated', entityType:'agent', entityId:req.params.agentId, details:{ budgetMonthlyCents } });
  res.json({ ok:true });
});

// GET /api/costs/estimate — estimate cost for a message
router.post('/estimate', (req, res) => {
  const { messages=[], model='', systemPrompt='' } = req.body;
  const chars = messages.reduce((s,m) => s+(m.content||'').length, 0) + systemPrompt.length;
  const estimatedTokens = Math.ceil(chars / 3.8);
  // Rough pricing: Ollama is free, estimate for reference only
  res.json({ chars, estimatedTokens, estimatedCostCents: 0, note: 'Local Ollama models have no API cost' });
});

module.exports = router;
