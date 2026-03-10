'use strict';
const express = require('express');
const db = require('../db/index');
const u = require('../utils/index');

const router = express.Router();

// ── PROJECTS ──────────────────────────────────────────────────────────────────
router.get('/projects', (req, res) => {
  res.json(db.getProjects(req.query.status||null));
});
router.post('/projects', (req, res) => {
  const { name, description='', workspaceId='', goalId='', status='active', sortOrder=0 } = req.body;
  if (!u.validateStr(name||'', 200)) return res.status(400).json({ error: 'INVALID_NAME' });
  try {
    const id = db.upsertProject({ name, description, workspaceId, goalId, status, sortOrder });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'project.created', entityType:'project', entityId:id, details:{ name } });
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/projects/:id', (req, res) => {
  try {
    db.upsertProject({ id: req.params.id, ...req.body });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'project.updated', entityType:'project', entityId:req.params.id });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.delete('/projects/:id', (req, res) => {
  db.deleteProject(req.params.id);
  db.logActivityV2({ actorType:'user', actorId:'user', action:'project.deleted', entityType:'project', entityId:req.params.id });
  res.json({ ok:true });
});

// ── GOALS ─────────────────────────────────────────────────────────────────────
router.get('/goals', (req, res) => {
  res.json(db.getGoals(req.query.projectId||null));
});
router.post('/goals', (req, res) => {
  const { title, description='', parentGoalId='', projectId='', status='active', priority='normal', dueDate=null } = req.body;
  if (!u.validateStr(title||'', 300)) return res.status(400).json({ error: 'INVALID_TITLE' });
  try {
    const id = db.upsertGoal({ title, description, parentGoalId, projectId, status, priority, dueDate });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'goal.created', entityType:'goal', entityId:id, details:{ title, priority } });
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/goals/:id', (req, res) => {
  try {
    db.upsertGoal({ id: req.params.id, title:'', ...req.body });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'goal.updated', entityType:'goal', entityId:req.params.id });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.delete('/goals/:id', (req, res) => {
  db.deleteGoal(req.params.id);
  res.json({ ok:true });
});

// ── ISSUES / KANBAN ───────────────────────────────────────────────────────────
router.get('/issues', (req, res) => {
  const { projectId, status } = req.query;
  const issues = db.getIssues(projectId||null, status||null);
  // Group by status for kanban
  if (req.query.kanban === 'true') {
    const grouped = { todo:[], in_progress:[], done:[], blocked:[] };
    for (const issue of issues) {
      const s = issue.status;
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(issue);
    }
    return res.json(grouped);
  }
  res.json(issues);
});
router.post('/issues', (req, res) => {
  const { title, description='', projectId='', assigneeAgentId='', status='todo', priority='normal', labels=[], sortOrder=0 } = req.body;
  if (!u.validateStr(title||'', 500)) return res.status(400).json({ error: 'INVALID_TITLE' });
  try {
    const id = db.upsertIssue({ title, description, projectId, assigneeAgentId, status, priority, labels, sortOrder });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'issue.created', entityType:'issue', entityId:id, details:{ title, status, priority } });
    db.updateSidebarBadges();
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/issues/:id', (req, res) => {
  try {
    const existing = db.getIssues().find(i => i.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
    db.upsertIssue({ ...existing, ...req.body, id: req.params.id, labels: req.body.labels || JSON.parse(existing.labels||'[]') });
    db.logActivityV2({ actorType:'user', actorId:'user', action:'issue.updated', entityType:'issue', entityId:req.params.id, details: req.body.status ? { status: req.body.status } : {} });
    db.updateSidebarBadges();
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.delete('/issues/:id', (req, res) => {
  db.deleteIssue(req.params.id);
  db.logActivityV2({ actorType:'user', actorId:'user', action:'issue.deleted', entityType:'issue', entityId:req.params.id });
  res.json({ ok:true });
});

// ── ISSUE COMMENTS ────────────────────────────────────────────────────────────
router.get('/issues/:id/comments', (req, res) => {
  res.json(db.getIssueComments(req.params.id));
});
router.post('/issues/:id/comments', (req, res) => {
  const { content, authorType='user', authorId='user' } = req.body;
  if (!u.validateStr(content||'', 10000)) return res.status(400).json({ error: 'INVALID' });
  const id = db.addIssueComment({ issueId: req.params.id, authorType, authorId, content });
  db.logActivityV2({ actorType: authorType, actorId: authorId, action:'issue.comment_added', entityType:'issue', entityId:req.params.id });
  res.json({ ok:true, id });
});

// ── WORKSPACES ────────────────────────────────────────────────────────────────
router.get('/workspaces', (req, res) => res.json(db.getWorkspaces()));
router.post('/workspaces', (req, res) => {
  const { name, cwd, repoUrl='', repoRef='main', description='', isPrimary=0 } = req.body;
  if (!u.validateStr(name||'', 200) || !u.validateStr(cwd||'', 1000)) return res.status(400).json({ error: 'INVALID' });
  const id = db.upsertWorkspace({ name, cwd, repoUrl, repoRef, description, isPrimary });
  res.json({ ok:true, id });
});
router.delete('/workspaces/:id', (req, res) => {
  db.deleteWorkspace(req.params.id);
  res.json({ ok:true });
});

module.exports = router;
