# SenecaChat v17

> A local-first agentic AI interface powered by Ollama. Runs entirely on your machine — no cloud, no subscriptions, no data leaving your network.

**4,740 lines** · **Node.js** · **SQLite WAL** · **Express** · **BM25 RAG** · **ReAct loop**

![ezgif-2464a0d50cb32015](https://github.com/user-attachments/assets/2366dc06-53fe-4fc7-bcad-3f2541e12600)


---

## What is this?

SenecaChat is a self-hosted chat interface that wraps any Ollama model in a full agentic runtime. It gives the model a persistent memory store, a shell execution environment, a document knowledge base, multi-agent orchestration, and a structured planning system.

It is not a wrapper around the OpenAI API. It talks directly to a local Ollama instance over HTTP.

---

## Features

### Core

| Feature | Details |
|---|---|
| **ReAct loop** | Unlimited iterations. Agent executes `exec` blocks, observes output, and continues until the task is done. No step cap. |
| **BM25 + semantic RAG** | Upload documents; the agent retrieves relevant chunks automatically using BM25 with optional cosine similarity hybrid scoring. |
| **SQLite WAL persistence** | All conversations, memory, tasks, notes, plans, and documents survive restarts. WAL mode for concurrent reads. |
| **Auth gate** | Token stored in `data/.auth_token` (owner-read-only). Pass as `Authorization: Bearer <token>` or `X-API-Key: <token>`. |
| **Streaming** | Chat responses stream token-by-token via SSE. Exec output streams separately. |
| **Circuit breaker** | Ollama connection failures trip the breaker after 4 errors; auto-recovers after 20s with a half-open probe. |
| **Rate limiting** | Chat: 120/min. Exec: 120/min. Heavy ops (orchestration, eval): 20/min. |

### v17 — Agentic Intelligence

**Reflexion** (`POST /api/reflect`)  
Implements the Shinn et al. (2022) Reflexion architecture. When a response scores poorly or a tool fails, the agent runs a structured 5-step self-critique — identifying what went wrong, the root cause, and a better approach — then produces an improved answer in the same turn. No human intervention required.

**Context engineering**  
Context rot is now flagged at 60% fill (down from 70%), based on research showing model quality degrades before the nominal limit. The compaction pipeline keeps the last 3 raw turns verbatim and applies observation masking to older turns, preserving the model's formatting momentum. Four-level banner system: `ok` → `[ROT ZONE]` → `[WARNING]` → `[CRITICAL]`.

**Todo checklist** (`GET/POST/PATCH /api/todo`)  
Manus-style `todo.md` checklist for long-horizon tasks. The agent creates, reads, and updates a per-session markdown checklist across its ReAct iterations. Markers: `[ ]` pending, `[~]` in-progress, `[x]` done.

**Session continuity**  
On the first turn of a new session, key facts and known errors from the namespaced memory store are automatically injected into the system prompt. Prior context carries forward without the user having to re-explain anything.

**Tool safety pre-scoring** (`GET /api/exec/safety-check`)  
Scores any shell command on a 0–100 risk scale before execution. Detects destructive flags, network writes, system directory writes, `eval`/`base64` decode chains, and pipe-to-shell patterns. High-risk commands are logged to the audit trail.

### Retained from v16 (OpenClaw)

- **Tool loop detection** — same command repeated 4× in a 2-minute window is blocked with a `[LOOP DETECTED]` signal
- **Tool result truncation** — 32K hard cap on exec output; 60/40 head/tail preservation with a truncation notice
- **Auto-compaction** at 80% context fill, preceded by a silent memory-flush turn that writes critical findings to the persistent store
- **Thinking-level fallback** — `think` mode is disabled automatically at 85% fill to preserve space for the response
- **Minimal prompt mode** — at 85%, the system prompt drops identity blocks and integration listings to save tokens
- **Duplicate reply suppression** — normalized text deduplication prevents the same segment streaming twice
- **Heartbeat probe** (`POST /api/heartbeat`) — autonomous check-in that reads a `HEARTBEAT.md` instruction file and acts on pending tasks

### Integrations

Configure API keys via `POST /api/secrets` or environment variables.

| Integration | Capabilities |
|---|---|
| **Google Drive** | List, read, create documents |
| **Google Sheets** | Read, write, append ranges |
| **Google Calendar** | List events, create events |
| **Slack** | List channels, read messages, send messages |
| **GitHub** | List repos, get user info, create issues |
| **Notion** | Search pages, create pages |
| **Brave Search** | Web search with up to 20 results |

### Multi-agent

| Endpoint | What it does |
|---|---|
| `POST /api/agents/orchestrate` | Decomposes a task into subtasks and assigns each to a specialist agent. Returns an executable plan. |
| `POST /api/agents/debate` | Runs a for/against debate on a proposition and produces a balanced synthesis. |
| `POST /api/agents/peer-review` | Scores content (code, prose, etc.) across critical bugs, minor issues, and suggestions. Returns a 0–100 score. |

**Built-in agents:** Coder, Researcher, Writer, Analyst, Critic, Planner. Custom agents can be added via `POST /api/agents`.

### Eval & quality

- `POST /api/eval/judge` — LLM-as-judge scoring on 5 dimensions: relevance, accuracy, completeness, clarity, conciseness
- `POST /api/eval/suite` + `POST /api/eval/suite/:id/run` — regression test suites with keyword pass/fail criteria
- `GET /api/eval/drift` — detects response quality drift by comparing recent vs baseline metric windows
- Automatic quality scoring on every chat response; format quality penalty for over-bulleted prose

---

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org/) ≥18, [Ollama](https://ollama.ai/) running locally.

```bash
git clone https://github.com/tamim1089/SenecaChat
cd SenecaChat
npm install
npm start
```

Open [http://localhost:3001](http://localhost:3001). On first run the auth token is written to `data/.auth_token`.

Pull a model if you haven't already:

```bash
ollama pull llama3.2
# or
ollama pull qwen2.5-coder:7b
```

Enter the model name in the SenecaChat settings panel, set your Ollama base URL (default `http://localhost:11434`), and start chatting.

---

## Configuration

All secrets and integration keys are stored in SQLite via `POST /api/secrets`. You can also pass them as environment variables — the server checks env first, then the DB.

| Variable | Description |
|---|---|
| `PORT` | Server port (default: `3001`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Google refresh token |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `GITHUB_TOKEN` | GitHub personal access token |
| `NOTION_TOKEN` | Notion integration token |
| `BRAVE_API_KEY` | Brave Search API key |

---

## API reference

### Chat & execution

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat` | Main chat endpoint. Streams SSE. Accepts `model`, `messages`, `thinkMode`, `useRag`, `autoExec`, `sessionId`, `contextSize`. |
| `POST` | `/api/exec` | Run a shell command synchronously. Returns stdout/stderr + truncation metadata. |
| `POST` | `/api/exec/smart` | Exec with 60s result cache. Loop-detection enabled. |
| `POST` | `/api/exec/parallel` | Run up to 10 commands concurrently. Returns array of results. |
| `POST` | `/api/exec/stream` | Streaming exec via SSE. |
| `GET` | `/api/exec/safety-check` | Score a command's risk before running. `?cmd=<command>` |
| `POST` | `/api/exec/destructive-check` | Returns `{ isDestructive, risk, requiresConfirmation }`. |
| `POST` | `/api/exec/reset-loop` | Clear loop-detection state for a session. |
| `POST` | `/api/abort/:reqId` | Abort an in-flight streaming request. |

### Memory

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/memory` | List entries. Filter by `?namespace=` or search by `?q=`. |
| `POST` | `/api/memory` | Store an entry. Body: `{ namespace, key, content, confidence }`. |
| `DELETE` | `/api/memory/:id` | Delete an entry. |
| `GET` | `/api/memory/namespaces` | Entry counts per namespace. |
| `GET` | `/api/memory/session-summary` | Continuity prompt synthesized from key facts, recent episodes, and known errors. |
| `POST` | `/api/memory/import` | Bulk-import entries from JSON. |
| `GET` | `/api/memory/export` | Export all memory as JSON. |
| `GET` | `/api/agent/memory` | Get the agent K/V scratchpad. |
| `POST` | `/api/agent/memory` | Set a K/V entry. Body: `{ key, value }`. |
| `DELETE` | `/api/agent/memory/:key` | Delete a K/V entry. |

**Memory namespaces:** `user_prefs` · `project_facts` · `past_errors` · `patterns` · `episodes`

### Documents & RAG

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/docs/ingest` | Upload a document (base64). Extracts text, chunks it, builds BM25 index. Supports PDF, DOCX, TXT, MD, and most code file types. |
| `GET` | `/api/docs` | List all ingested documents. |
| `DELETE` | `/api/docs/:id` | Delete a document and its chunks. |
| `POST` | `/api/docs/search` | BM25 search. Body: `{ query, topK, hybrid }`. |

### Planning & tasks

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/plans` | Create a plan with steps. Body: `{ task, steps: [{ description }] }`. |
| `GET` | `/api/plans` | List all plans. |
| `PATCH` | `/api/plans/:id/step` | Update a step status. Body: `{ stepId, status, result }`. |
| `DELETE` | `/api/plans/:id` | Delete a plan. |
| `GET` | `/api/todo` | Get the current session todo list. `?sessionId=` |
| `POST` | `/api/todo` | Create or replace a todo list. Body: `{ sessionId, content }` or `{ sessionId, items: [] }`. |
| `PATCH` | `/api/todo` | Update a single item status. Body: `{ sessionId, index, status }`. |

### Reflexion & quality

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/reflect` | Run Reflexion on a failed response. Body: `{ model, baseUrl, query, response, error }`. Returns improved answer. |
| `POST` | `/api/eval/judge` | LLM-as-judge scoring. Body: `{ model, baseUrl, response, query }`. |
| `POST` | `/api/eval/suite` | Create a regression test suite. |
| `POST` | `/api/eval/suite/:id/run` | Run all tests in a suite against a model. |
| `GET` | `/api/eval/drift` | Compare recent vs baseline quality metrics. |
| `POST` | `/api/feedback` | Record thumbs up/down. Body: `{ messageId, sessionId, rating, comment }`. |

### Context management

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/compact` | Summarise history. Fires memory flush first (once per session). Returns `summary` + reset `compactedMessages`. |
| `GET` | `/api/compact/snapshot` | Retrieve a pending compaction snapshot for a session. `?sessionId=` |
| `POST` | `/api/heartbeat` | Autonomous check-in. Reads `HEARTBEAT.md` and acts on pending tasks. |
| `POST` | `/api/tokens/estimate` | Estimate token count for messages + system prompt. |
| `POST` | `/api/analyze` | Classify a message: returns `intent`, `complexity`, `domain`, `tone`, `shouldThink`, `suggestedTemp`. |

### Conversations

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/conversations` | List all conversations. |
| `POST` | `/api/conversations` | Save or update a conversation. |
| `GET` | `/api/conversations/:id` | Load a conversation. |
| `PATCH` | `/api/conversations/:id` | Rename a conversation. |
| `DELETE` | `/api/conversations/:id` | Delete a conversation. |
| `GET` | `/api/conversations/:id/export` | Export as Markdown. |
| `POST` | `/api/conversations/:id/duplicate` | Duplicate a conversation. |
| `POST` | `/api/conversations/bulk-delete` | Delete multiple conversations by ID array. |
| `GET` | `/api/conversations/search` | Full-text search across all conversations. |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Returns uptime, memory usage, circuit breaker state, and DB row counts. |
| `GET` | `/api/system/stats` | Detailed stats including per-namespace memory counts. |
| `GET` | `/api/metrics` | Raw metric time series. `?type=&last=100` |
| `GET` | `/api/metrics/summary` | Aggregated metric summaries. |
| `GET` | `/api/audit` | Last 200 audit log entries. |
| `GET` | `/api/errors` | Recent error log. |
| `GET` | `/api/logs/stream` | SSE stream of live server console output. |
| `GET` | `/api/integrations/status` | Which integrations are configured. |
| `POST` | `/api/secrets` | Store integration API keys. Body: `{ KEY_NAME: "value" }`. |

---

## Architecture

```
senecachat-v17/
├── server.js                    # Express app — all routes, circuit breaker, streaming
├── src/
│   ├── db/
│   │   └── index.js             # All SQLite operations (~770 lines, 27 tables)
│   ├── utils/
│   │   ├── index.js             # BM25, intent/domain/complexity detection,
│   │   │                        # context budgeting, loop detection, Reflexion,
│   │   │                        # safety scoring, todo helpers (~430 lines)
│   │   └── systemPrompt.js      # System prompt builder — context banners, todo
│   │                            # injection, session continuity, prompt modes
│   ├── middleware/
│   │   └── auth.js              # Bearer token + X-API-Key middleware
│   └── rag.js                   # BM25 RAG helpers
└── public/
    └── index.html               # Single-file SPA (~2,500 lines)
```

### Request lifecycle

```
POST /api/chat
  ↓  Intent / domain / complexity classification
  ↓  Relevant memory retrieval (BM25 over memory store)
  ↓  Context budget calculation
  ↓  System prompt assembly (full or minimal mode)
  ↓  Compaction check  ──── ≥80% → compact signal to frontend
  ↓  Thinking fallback ──── ≥85% → disable think mode
  ↓  Ollama /api/chat (streaming, with retry + circuit breaker)
  ↓  Duplicate suppression (normalized text dedup)
  ↓  Response quality scoring + format quality scoring
  ↓  Metric recording
  ↓  SSE stream to browser
```

### Context management thresholds

| Fill % | Action |
|---|---|
| 60% | `[ROT ZONE]` banner injected into system prompt |
| 70% | `[WARNING]` banner — be concise |
| 80% | Compact signal sent to frontend; memory flush fires (once per session) |
| 85% | Prompt switches to minimal mode; thinking disabled; `[CRITICAL]` banner |

---

## Database schema

27 SQLite tables. All writes use prepared statements. WAL mode is enabled on boot.

**Core:** `conversations` · `docs` · `doc_chunks` · `memory` · `agent_memory` · `plans` · `todos` *(v17)*

**Workflow:** `tasks` · `notes` · `templates` · `approvals` · `sessions` · `revisions`

**Observability:** `metrics` · `feedback` · `audit_log` · `errors_log`

**Agents & eval:** `agents` · `agent_messages` · `eval_suites` · `task_queue` · `trajectories`

**Learning:** `improvements` · `prompt_versions` · `ab_tests`

**Config:** `kv_store` · `secrets` · `user_prefs`

---

## Utility functions

Key exports from `src/utils/index.js`:

| Function | Description |
|---|---|
| `classifyIntent(msg)` | Returns `debug` / `create` / `explain` / `execute` / `retrieve` / `refactor` / `compare` / `task` |
| `scoreComplexity(msg, messages)` | Returns `simple` / `medium` / `complex` |
| `detectDomain(msg, messages)` | Returns `coding` / `sysadmin` / `data` / `writing` / `math` / `general` |
| `detectTone(msg)` | Returns `urgent` / `frustrated` / `positive` / `neutral` |
| `shouldThinkHeuristic(msg)` | Returns `true` if ≥3 of 10 complexity signals fire |
| `buildTokenBudget(messages, sysPrompt, contextSize)` | Returns `{ used, remaining, pct, nearLimit }` |
| `checkToolLoop(sessionId, cmd)` | Returns `{ loop: true }` after 4 repeats in 2 minutes |
| `truncateToolResult(output, cap)` | Caps at 32K with 60/40 head/tail split |
| `buildReflexionPrompt(query, response, error)` | Generates structured Reflexion self-critique prompt |
| `detectContextRot(tokenBudget)` | Returns `{ rot, critical, level }` at 60% / 85% thresholds |
| `buildCompactionPromptV17(messages, keepRawTurns)` | Observation-masked compaction; keeps last N turns verbatim |
| `scoreToolSafety(cmd)` | Returns `{ score, risk, requiresNotice }` on a 0–100 scale |
| `scoreResponseFormat(response, domain, intent)` | Penalizes over-bulleted prose in non-code domains |
| `parseTodoList(text)` / `formatTodoList(todos)` | Parse and format `[ ]` / `[~]` / `[x]` markdown checklists |

---

## Development

```bash
# Hot reload
npm run dev

# Syntax check all source files
node --check server.js
node --check src/utils/index.js
node --check src/utils/systemPrompt.js
node --check src/db/index.js

# Inspect the database
sqlite3 data/seneca.db ".tables"
sqlite3 data/seneca.db "SELECT namespace, COUNT(*) FROM memory GROUP BY namespace;"

# Tail live server logs
curl -N http://localhost:3001/api/logs/stream

# Health check
curl http://localhost:3001/api/health | jq .
```

---

## Security

- Auth token is generated with `crypto.randomBytes(32)` and written to `data/.auth_token` with `0600` permissions on first run
- Prompt injection detection runs on every user message; attempts are logged to the audit table
- All shell commands are validated before execution; loop detection prevents runaway iteration
- Tool outputs from external sources are explicitly marked untrusted in the system prompt (OWASP LLM Top 10 2025)
- Secrets are stored in SQLite only; the secrets table is excluded from all exports
- The system prompt cannot be revealed — the model is instructed to refuse and the instruction is marked immutable

---

## Author

Built by **Abdulrahman Tamim**

[LinkedIn](https://www.linkedin.com/in/abdulrahman-tamim/) · [Blog](https://tamim1089.github.io/)
