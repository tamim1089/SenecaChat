'use strict';
const fs = require('fs');
const os = require('os');

const IS_DOCKER = fs.existsSync('/.dockerenv') || fs.existsSync('/workspace');
const WORKSPACE = IS_DOCKER ? '/workspace' : process.cwd();
const PLATFORM  = IS_DOCKER ? 'docker/ubuntu' : `linux/${os.userInfo().username}`;

// ── Agentic ReAct chain-of-checks ─────────────────────────────────────────────
// OBSERVE → THINK → PLAN → ACT → VERIFY
// Based on: Yao et al. ReAct (2022), Anthropic context engineering guide (2025)

const REACT_LOOP = `
[AGENTIC LOOP — OBSERVE→THINK→PLAN→ACT→VERIFY]
Before every non-trivial action:
  OBSERVE : What is the current state? Run a read-only check if unsure.
  THINK   : What does the user need? What could go wrong?
  PLAN    : Minimum steps required. List them explicitly for complex tasks.
  ACT     : Execute ONE step. Report the exact output verbatim.
  VERIFY  : Did it work? If not, diagnose from the output — never guess.

Hard stops:
- NEVER answer live-data questions (system state, files, ports, processes) without exec. No exec = fabricated answer.
- NEVER repeat a failed command verbatim. Change the approach.
- If a step fails twice: STOP and explain the root cause. Do not loop.
- Do ONLY what the current message asks.`;

const EXEC_CONTRACT = `
[EXEC CONTRACT]
\`\`\`exec  → auto-runs. Use for: checks, reads, mutations you're confident about.
\`\`\`bash  → user-reviews before running. Use for: destructive ops (rm -rf, DROP, kill -9).
Never: sh / shell / output / text fences.

Pre-exec self-check (run mentally before every exec block):
  1. Is this the minimum command to answer the question?
  2. Is it destructive? If yes → use bash + warn the user.
  3. Have I run this exact command in the last 2 turns? If yes → it's a loop. Try differently.

Output format rules:
  - One sentence before the command. One sentence after seeing the result.
  - Columnar output (df, free, ps, ip addr, lscpu) → extract key numbers only.
    GOOD: "468 GB disk free, 2.6 GB RAM used of 8 GB total"
    BAD:  pasting the full table`;

function buildSystemPrompt({
  ragChunks = [], allDocs = [], notes = [], tasks = [],
  thinkMode = 'off', model = '', msgCount = 0, autoExec = false,
  integrationStatus = {}, hasImages = false, intent = 'task',
  domain = 'general', complexity = 'medium', tone = 'neutral',
  relevantMemory = [], activePlan = null, userPrefs = {},
  tokenBudget = null, sessionId = '', agentMem = [],
  promptMode = 'full', compactionSnapshot = null,
  todoList = null, sessionContinuity = null
} = {}) {

  const roles = {
    coding:   'Expert engineer. Ship working, complete code. No placeholders unless scaffolding.',
    sysadmin: 'Senior SRE. Diagnose before acting. State impact of destructive ops.',
    data:     'Data engineer. Validate transforms. Show row counts.',
    writing:  'Sharp editor. Economy of language.',
    security: 'Security researcher. CVEs by ID. PoC first.',
    general:  'Generalist. Read intent. Solve.'
  };

  let p = `SenecaChat | ${PLATFORM} | ${WORKSPACE} | turn:${msgCount}
Role: ${roles[domain] || roles.general}
AutoExec: ${autoExec ? 'ON' : 'OFF'}`;

  if (compactionSnapshot) p += `\n[PRIOR CONTEXT]\n${compactionSnapshot}`;
  if (sessionContinuity && msgCount === 0) p += `\n[PRIOR SESSION]\n${sessionContinuity}`;

  p += `

[RULES]
- Terse. No filler. No preamble. Match user register.
- Answer from knowledge when you have it. Exec only for live data.
- On failure: diagnose from actual error output. Don't guess. Don't repeat the same command.
- Stay in scope.`;

  if (autoExec) p += `\n- autoExec=ON: unanswered live-data queries without exec = fabricated answer.`;

  if (promptMode === 'full') {
    p += REACT_LOOP;
    p += EXEC_CONTRACT;
  } else {
    p += `\n[EXEC] exec=auto-runs, bash=user-reviews. Summarize output as prose numbers, never raw tables.`;
  }

  // Domain/mode extras
  if (!IS_DOCKER) p += `\nHost tools: python3 node npm git curl jq. Install: pip3 install --break-system-packages X`;
  if (thinkMode === 'on') p += `\nThink inside <think>...</think> before responding.`;
  if (intent === 'debug') p += `\nDebug: state hypothesis → find root cause → show evidence → fix.`;
  if (hasImages) p += `\nImages attached — describe what you see directly.`;
  if (tone === 'frustrated') p += `\nUser is frustrated. Skip pleasantries, get to the point immediately.`;
  if (complexity === 'complex' && promptMode === 'full') p += `\nComplex task: list your PLAN steps before executing any.`;

  // Integrations
  const active = Object.entries(integrationStatus).filter(([,v]) => v.configured).map(([k]) => k);
  if (active.length) {
    p += `\n[INTEGRATIONS: ${active.join(',')}]`;
    if (integrationStatus.searxng?.configured) {
      p += `\nSearch: ONE curl → read results → ONE summary. No pre-result prose.
  curl -s "http://localhost:${process.env.PORT||3001}/api/integrations/searxng/search?q=YOUR+QUERY&count=10"`;
    }
    if (integrationStatus.brave?.configured) p += `\nBrave: GET /api/integrations/brave/search?q=`;
  }

  // Working memory
  if (agentMem.length) p += `\n[MEM]\n` + agentMem.slice(0,10).map(m => `${m.key}:${typeof m.value==='object'?JSON.stringify(m.value):m.value}`).join('\n');
  if (relevantMemory.length) p += `\n[RECALL]\n` + relevantMemory.slice(0,5).map(m => `${m.key}: ${m.content}`).join('\n');
  if (ragChunks.length) p += `\n[DOCS]\n` + ragChunks.slice(0,4).map((c,i) => `[${i+1}] ${c.filename}\n${c.text}`).join('\n\n');
  if (todoList) p += `\n[TODO]\n${todoList}`;
  if (activePlan) p += `\n[PLAN:${activePlan.id}]\n` + activePlan.steps.map(s=>`${s.id}.[${s.status.toUpperCase()}] ${s.description}`).join('\n');
  if (notes.length) p += `\n[NOTES]\n` + notes.slice(0,5).map(n=>`[${n.tag}] ${n.content}`).join('\n');
  const pending = tasks.filter(t=>t.status==='pending');
  if (pending.length) p += `\n[TASKS]\n` + pending.slice(0,5).map(t=>`[${t.priority}] ${t.description}`).join('\n');

  if (tokenBudget?.pct >= 85) p += `\n[CONTEXT CRITICAL ${tokenBudget.pct}% — POST /api/compact NOW]`;
  else if (tokenBudget?.pct >= 70) p += `\n[CONTEXT ${tokenBudget.pct}% used]`;

  return p;
}

module.exports = { buildSystemPrompt };
