# SenecaChat Refactor — v18.0.0 → v18.1.0

## What was removed (overengineering)

### `server.js`
- **Removed `/api/exec/smart`** — was 95% identical to `/api/exec`. Cache and loop-detection logic
  has been merged into the single `/api/exec` endpoint. `bypassCache` param still works.
- **Removed dead `/api/history` shim endpoints** (`GET/POST/DELETE /api/history`, `/api/history/tokens`)
  — these returned empty responses and were never used by the frontend.
- **Removed `REACT_MAX` constant** from systemPrompt.js — it was set to 10 but never enforced.
  The system prompt already said "unlimited iterations". Conflicting signal removed.
- **Removed `_bm25CacheVersion` counter** — unused, `_bm25Cache = null` is the invalidation mechanism.

### `systemPrompt.js`
- Removed the first-turn chain planning injection (commented out with "// First-turn chain planning removed — causes spiral behavior") — it was already disabled.

## What was added (engineering where needed)

### Agentic chain-of-checks in `systemPrompt.js`
The system prompt now explicitly enforces a **ReAct loop**:

```
OBSERVE → THINK → PLAN → ACT → VERIFY
```

Based on:
- Yao et al. "ReAct: Synergizing Reasoning and Acting in Language Models" (2022)
- Anthropic "Effective context engineering for AI agents" (2025)
- Amazon "Evaluating AI agents at scale" (2025)

**Why this matters for "show system info" and similar queries:**
The old prompt had good rules but no *loop structure*. The model could still answer
live-data questions from memory. The new OBSERVE-first constraint makes explicit:
> "NEVER answer live-data questions (system state, files, ports, processes) without exec.
> No exec = fabricated answer."

### Pre-exec self-check contract
Every exec block is preceded by a 3-point mental checklist the model must run:
1. Is this the minimum command to answer the question?
2. Is it destructive? If yes → use bash + warn.
3. Have I run this exact command in the last 2 turns? If yes → it's a loop.

This directly addresses the screenshot: the model was being verbose and theoretical
about `show system info` rather than just running `uname -a && free -h && df -h /`.

### Unified `/api/exec` endpoint
- Loop detection: ✓ (was only in `/api/exec` and `/api/exec/smart`)
- Safety scoring: ✓
- Caching: ✓ (only for safe read-only commands, score < 20)
- `bypassCache` param: ✓
- Correct `cwd` handling: ✓ (uses `/workspace` in Docker, `__dirname` on host)

## File-by-file diff summary

| File | Before | After | Delta |
|------|--------|-------|-------|
| server.js | 1080 lines | 864 lines | −216 |
| systemPrompt.js | 89 lines | 124 lines | +35 |

The +35 lines in systemPrompt.js are the agentic loop and exec contract — the engineering
that was missing. The −216 lines in server.js are dead code and duplicate endpoints.
