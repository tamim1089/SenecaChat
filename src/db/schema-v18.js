'use strict';
// ── SenecaChat v18 Schema Extensions ─────────────────────────────────────────
// Brings in patterns from Paperclip (cost tracking, agent runs, activity log,
// sidebar badges, wakeup queue, live events, workspace sessions) + 100+ more
// features from OpenClaw skills ecosystem.

const SCHEMA_V18 = `
  -- ── Cost & Token Tracking (from Paperclip costService) ──────────────────
  CREATE TABLE IF NOT EXISTS cost_events (
    id TEXT PRIMARY KEY,
    session_id TEXT DEFAULT '',
    agent_id TEXT DEFAULT 'default',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT DEFAULT 'ollama',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    cost_cents INTEGER DEFAULT 0,
    billing_code TEXT DEFAULT '',
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_cost_occurred ON cost_events(occurred_at DESC);

  -- ── Agent Budget (from Paperclip agents table) ────────────────────────────
  CREATE TABLE IF NOT EXISTS agent_budgets (
    agent_id TEXT PRIMARY KEY,
    budget_monthly_cents INTEGER DEFAULT 0,
    spent_monthly_cents INTEGER DEFAULT 0,
    budget_reset_at INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    updated_at INTEGER NOT NULL
  );

  -- ── Heartbeat Runs (from Paperclip heartbeat.ts) ─────────────────────────
  CREATE TABLE IF NOT EXISTS heartbeat_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT DEFAULT 'default',
    invocation_source TEXT DEFAULT 'on_demand',
    trigger_detail TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'queued',
    session_id TEXT DEFAULT '',
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT DEFAULT '',
    exit_code INTEGER,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_cents INTEGER DEFAULT 0,
    stdout_excerpt TEXT DEFAULT '',
    stderr_excerpt TEXT DEFAULT '',
    context_snapshot TEXT DEFAULT '{}',
    result_json TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hb_runs_agent ON heartbeat_runs(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hb_runs_status ON heartbeat_runs(status);

  -- ── Heartbeat Run Events (from Paperclip heartbeat_run_events) ────────────
  CREATE TABLE IF NOT EXISTS heartbeat_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL DEFAULT 'log',
    level TEXT DEFAULT 'info',
    message TEXT NOT NULL,
    meta TEXT DEFAULT '{}',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hb_events_run ON heartbeat_run_events(run_id, ts);

  -- ── Wakeup Queue (from Paperclip agentWakeupRequests) ────────────────────
  CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
    id TEXT PRIMARY KEY,
    agent_id TEXT DEFAULT 'default',
    source TEXT DEFAULT 'on_demand',
    reason TEXT DEFAULT '',
    payload TEXT DEFAULT '{}',
    idempotency_key TEXT DEFAULT '',
    requested_by TEXT DEFAULT 'user',
    status TEXT DEFAULT 'pending',
    run_id TEXT DEFAULT '',
    coalesced_into TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wakeup_idempotency ON agent_wakeup_requests(idempotency_key) WHERE idempotency_key != '';

  -- ── Activity Log (from Paperclip activity-log.ts) ─────────────────────────
  CREATE TABLE IF NOT EXISTS activity_log_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT DEFAULT 'user',
    actor_id TEXT DEFAULT 'user',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'message',
    entity_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT DEFAULT '',
    run_id TEXT DEFAULT '',
    details TEXT DEFAULT '{}',
    redacted INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_v2_action ON activity_log_v2(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_v2_entity ON activity_log_v2(entity_type, entity_id);

  -- ── Task Sessions (from Paperclip agentTaskSessions) ─────────────────────
  CREATE TABLE IF NOT EXISTS agent_task_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT DEFAULT 'default',
    task_key TEXT NOT NULL,
    session_params TEXT DEFAULT '{}',
    workspace_cwd TEXT DEFAULT '',
    workspace_source TEXT DEFAULT 'agent_home',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(agent_id, task_key)
  );

  -- ── Workspace Registry ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    repo_url TEXT DEFAULT '',
    repo_ref TEXT DEFAULT 'main',
    description TEXT DEFAULT '',
    is_primary INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ── Projects ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    workspace_id TEXT DEFAULT '',
    goal_id TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

  -- ── Goals Hierarchy ───────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    parent_goal_id TEXT DEFAULT '',
    project_id TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    priority TEXT DEFAULT 'normal',
    due_date INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ── Issues / Kanban ───────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    project_id TEXT DEFAULT '',
    assignee_agent_id TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'normal',
    labels TEXT DEFAULT '[]',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

  -- ── Issue Comments ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS issue_comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_type TEXT DEFAULT 'user',
    author_id TEXT DEFAULT 'user',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_issue ON issue_comments(issue_id, created_at);

  -- ── Labels ────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#6366f1',
    created_at INTEGER NOT NULL
  );

  -- ── Sidebar Badges Cache (from Paperclip sidebarBadgeService) ─────────────
  CREATE TABLE IF NOT EXISTS sidebar_badge_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    approvals_pending INTEGER DEFAULT 0,
    failed_runs INTEGER DEFAULT 0,
    unread_issues INTEGER DEFAULT 0,
    inbox_total INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO sidebar_badge_cache (id, updated_at) VALUES (1, 0);

  -- ── Conversation Branches ─────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS conversation_branches (
    id TEXT PRIMARY KEY,
    parent_conversation_id TEXT NOT NULL,
    branch_at_message_index INTEGER NOT NULL,
    messages TEXT DEFAULT '[]',
    name TEXT DEFAULT 'Branch',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_branches_parent ON conversation_branches(parent_conversation_id);

  -- ── Pinned Messages ───────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS pinned_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    content_preview TEXT DEFAULT '',
    pinned_by TEXT DEFAULT 'user',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pinned_conv ON pinned_messages(conversation_id);

  -- ── Message Reactions ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, message_index, emoji)
  );

  -- ── Search History ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    result_count INTEGER DEFAULT 0,
    search_type TEXT DEFAULT 'rag',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_search_history_ts ON search_history(ts DESC);

  -- ── Clipboard History ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS clipboard_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    content_type TEXT DEFAULT 'text',
    source TEXT DEFAULT 'manual',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_clipboard_ts ON clipboard_history(ts DESC);

  -- ── Feature Flags ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS feature_flags (
    flag TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    rollout_pct INTEGER DEFAULT 100,
    description TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  -- ── Prompt Library ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS prompt_library (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    tags TEXT DEFAULT '[]',
    use_count INTEGER DEFAULT 0,
    is_system INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_lib_category ON prompt_library(category);

  -- ── Conversation Export Queue ─────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    format TEXT DEFAULT 'markdown',
    status TEXT DEFAULT 'pending',
    output_path TEXT DEFAULT '',
    error TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  -- ── Webhooks ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    events TEXT DEFAULT '[]',
    secret TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    last_triggered INTEGER,
    fail_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ── Scheduled Tasks ───────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron TEXT DEFAULT '',
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_status TEXT DEFAULT 'never',
    action TEXT NOT NULL,
    payload TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sched_next ON scheduled_tasks(next_run_at) WHERE enabled = 1;

  -- ── Model Comparison ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS model_comparisons (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    results TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  );

  -- ── API Keys (for external REST access) ───────────────────────────────────
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    permissions TEXT DEFAULT '["read"]',
    last_used INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );

  -- ── Rate Limit Buckets ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ── Session Continuity ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS session_continuity (
    session_id TEXT PRIMARY KEY,
    continuity_prompt TEXT DEFAULT '',
    last_domain TEXT DEFAULT '',
    last_model TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  -- ── Notification Center ───────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    data TEXT DEFAULT '{}',
    read INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);

  -- ── Tool Usage Stats ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS tool_usage_stats (
    tool TEXT PRIMARY KEY,
    call_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    total_latency_ms INTEGER DEFAULT 0,
    last_used INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ── Orphaned Run Registry (for reaping) ───────────────────────────────────
  CREATE TABLE IF NOT EXISTS orphaned_runs (
    run_id TEXT PRIMARY KEY,
    agent_id TEXT DEFAULT '',
    detected_at INTEGER NOT NULL,
    reaped INTEGER DEFAULT 0,
    reaped_at INTEGER
  );

  -- ── Privacy / Incognito Sessions ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS incognito_sessions (
    session_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    message_count INTEGER DEFAULT 0
  );

  -- ── Model Personas ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS model_personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    system_prompt TEXT NOT NULL,
    avatar_emoji TEXT DEFAULT '🤖',
    is_default INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ── Conversation Tags ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS conversation_tags (
    conversation_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_conv_tags_tag ON conversation_tags(tag);

  -- ── Backup Manifest ───────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS backup_manifest (
    id TEXT PRIMARY KEY,
    backup_path TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    tables_included TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    verified INTEGER DEFAULT 0
  );

  -- ── Request Trace Log ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS request_traces (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_traces_ts ON request_traces(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_path ON request_traces(path, ts DESC);

  -- ── Memory Consolidation Log ──────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS memory_consolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT DEFAULT 'scheduled',
    entries_before INTEGER DEFAULT 0,
    entries_after INTEGER DEFAULT 0,
    summary TEXT DEFAULT '',
    ts INTEGER NOT NULL
  );

  -- ── Diff/Patch History ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS code_diffs (
    id TEXT PRIMARY KEY,
    session_id TEXT DEFAULT '',
    filename TEXT NOT NULL,
    before_hash TEXT DEFAULT '',
    after_hash TEXT DEFAULT '',
    patch TEXT NOT NULL,
    applied INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diffs_session ON code_diffs(session_id, created_at DESC);
`;

module.exports = { SCHEMA_V18 };
