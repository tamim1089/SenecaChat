'use strict';
const express = require('express');
const db = require('../db/index');

const router = express.Router();

// ── ACTIVITY LOG v2 ───────────────────────────────────────────────────────────
router.get('/activity', (req, res) => {
  const { limit=100, entityType } = req.query;
  res.json(db.getActivityLogV2(parseInt(limit)||100, entityType||null));
});

// ── SIDEBAR BADGES (Paperclip sidebarBadgeService) ────────────────────────────
router.get('/badges', (req, res) => {
  res.json(db.getSidebarBadges());
});
router.post('/badges/refresh', (req, res) => {
  res.json(db.updateSidebarBadges());
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
router.get('/notifications', (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  res.json(db.getNotifications(unreadOnly));
});
router.get('/notifications/count', (req, res) => {
  res.json({ count: db.getUnreadNotificationCount() });
});
router.post('/notifications', (req, res) => {
  const { type, title, message='', data={} } = req.body;
  if (!type || !title) return res.status(400).json({ error: 'type and title required' });
  const id = db.addNotification({ type, title, message, data });
  res.json({ ok:true, id });
});
router.patch('/notifications/:id/read', (req, res) => {
  db.markNotificationRead(req.params.id);
  res.json({ ok:true });
});
router.post('/notifications/read-all', (req, res) => {
  db.markNotificationRead('all');
  res.json({ ok:true });
});

// ── TOOL STATS ────────────────────────────────────────────────────────────────
router.get('/tool-stats', (req, res) => {
  res.json(db.getToolStats());
});

// ── FEATURE FLAGS ─────────────────────────────────────────────────────────────
router.get('/flags', (req, res) => {
  res.json(db.getAllFeatureFlags());
});
router.get('/flags/:flag', (req, res) => {
  res.json({ flag: req.params.flag, enabled: db.getFeatureFlag(req.params.flag) });
});
router.patch('/flags/:flag', (req, res) => {
  const { enabled, description='' } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
  db.setFeatureFlag(req.params.flag, enabled, description);
  db.logActivityV2({ actorType:'user', actorId:'user', action:'feature_flag.updated', entityType:'flag', entityId:req.params.flag, details:{ enabled } });
  res.json({ ok:true });
});

module.exports = router;
