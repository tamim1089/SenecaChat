'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db/index');

const router = express.Router();
const activeRuns = new Map(); // runId -> { abort }

// POST /api/runs/start — create and start a heartbeat run
router.post('/start', async (req, res) => {
  const { agentId='default', source='on_demand', triggerDetail='manual', sessionId='', contextSnapshot={}, baseUrl, model } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });

  // Check concurrent run limit
  const budget = db.getAgentBudget(agentId);
  if (budget.status === 'paused') return res.status(429).json({ error: 'Agent is paused (budget exceeded)' });

  const runId = db.createHeartbeatRun({ agentId, source, triggerDetail, sessionId, contextSnapshot });
  db.startHeartbeatRun(runId);
  db.addRunEvent(runId, { eventType:'lifecycle', level:'info', message:'Run started', meta:{ source, triggerDetail } });
  db.logActivityV2({ actorType:'user', actorId:'user', action:'run.started', entityType:'heartbeat_run', entityId:runId, agentId, details:{ source, triggerDetail } });
  db.updateSidebarBadges();

  res.json({ ok:true, runId });
});

// POST /api/runs/:id/finish — mark run complete
router.post('/:id/finish', (req, res) => {
  const { status='completed', exitCode=0, inputTokens=0, outputTokens=0, costCents=0, error='', stdoutExcerpt='', stderrExcerpt='', resultJson={} } = req.body;
  db.finishHeartbeatRun(req.params.id, { status, exitCode, inputTokens, outputTokens, costCents, error, stdoutExcerpt, stderrExcerpt, resultJson });
  if (costCents > 0) db.recordCostEvent({ sessionId:'', agentId:'default', model:'', inputTokens, outputTokens, costCents });
  db.addRunEvent(req.params.id, { eventType:'lifecycle', level: status==='failed'?'error':'info', message:`Run ${status}`, meta:{ exitCode, costCents } });
  db.logActivityV2({ actorType:'system', actorId:'system', action:`run.${status}`, entityType:'heartbeat_run', entityId:req.params.id, details:{ exitCode, costCents } });
  db.updateSidebarBadges();
  res.json({ ok:true });
});

// POST /api/runs/:id/event — append a log event
router.post('/:id/event', (req, res) => {
  const { eventType='log', level='info', message='', meta={} } = req.body;
  db.addRunEvent(req.params.id, { eventType, level, message, meta });
  res.json({ ok:true });
});

// GET /api/runs — list runs
router.get('/', (req, res) => {
  const { agentId, limit=20 } = req.query;
  res.json(db.getHeartbeatRuns(agentId||null, parseInt(limit)||20));
});

// GET /api/runs/:id/events — stream or list run events
router.get('/:id/events', (req, res) => {
  const stream = req.query.stream === 'true';
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const events = db.getRunEvents(req.params.id);
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write(`data: {"__done":true}\n\n`);
    return res.end();
  }
  res.json(db.getRunEvents(req.params.id));
});

// POST /api/runs/wakeup — enqueue an agent wakeup
router.post('/wakeup', (req, res) => {
  const { agentId='default', source='on_demand', reason='', payload={}, idempotencyKey='', requestedBy='user' } = req.body;
  const result = db.enqueueWakeup({ agentId, source, reason, payload, idempotencyKey, requestedBy });
  db.logActivityV2({ actorType:'user', actorId:'user', action:'wakeup.enqueued', entityType:'wakeup_request', entityId:result.id, agentId, details:{ source, reason, coalesced:result.coalesced } });
  res.json({ ok:true, ...result });
});

// GET /api/runs/wakeups/pending
router.get('/wakeups/pending', (req, res) => {
  res.json(db.getPendingWakeups(req.query.agentId||null));
});

// POST /api/runs/reap-orphans — reap stale running jobs on startup
router.post('/reap-orphans', (req, res) => {
  const count = db.reapOrphanedRuns();
  res.json({ ok:true, reaped: count });
});

module.exports = router;
