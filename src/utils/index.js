'use strict';
const crypto = require('crypto');

// ── Stop words ────────────────────────────────────────────────────────────────
const SW = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','to','of','in','on','at','by','for','with','about','as','into','through','before','after','each','this','that','these','those','i','you','he','she','it','we','they','and','or','but','not','so','if','then','than','when','where','who','what','how','all','any','both','few','more','most','other','some','such','no','nor','only','same','too','very','just','while','our','their','its','my','your','his','her','which','there','here','from','up','out']);

function tokenize(t) {
  return (t||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 1 && !SW.has(w));
}
function cosineSim(a, b) {
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
  const inter = [...ta].filter(t => tb.has(t)).length;
  if (!ta.size || !tb.size) return 0;
  return inter / Math.sqrt(ta.size * tb.size);
}
function estimateTokens(text) { return Math.ceil((text || '').length / 3.8); }
function validateStr(v, max = 10000) { return typeof v === 'string' && v.length <= max; }
function sanitizeFilename(n) { return require('path').basename(n).replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 255); }
function redactSensitive(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, '[KEY_REDACTED]')
    .replace(/\b(Bearer [a-zA-Z0-9._\-]{20,})\b/g, 'Bearer [REDACTED]')
    .replace(/password[":\s=]+["']?[^"'\s,}]{4,}/gi, 'password=[REDACTED]');
}
function detectInjection(t) {
  if (!t) return false;
  return [/ignore (all |previous )?instructions/i,/you are now\s+\w/i,/disregard.*system (prompt|instructions)/i,/\[SYSTEM\]|<\|system\|>/i,/forget (all |your )?(previous |prior )?instructions/i].some(p => p.test(t));
}
function hashText(text) { return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8); }
function safeParseJSON(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }

// ── BM25 ──────────────────────────────────────────────────────────────────────
function tfVector(t) {
  const tokens = tokenize(t), freq = {};
  for (const w of tokens) freq[w] = (freq[w] || 0) + 1;
  return { freq, len: tokens.length };
}
function bm25(qT, docFreq, dl, avgL, N, df) {
  const k1 = 1.5, b = 0.75; let s = 0;
  for (const t of qT) {
    const tf = docFreq[t] || 0; if (!tf) continue;
    const dfc = df[t] || 0;
    const idf = Math.log((N - dfc + 0.5) / (dfc + 0.5) + 1);
    s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / Math.max(avgL, 1))));
  }
  return s;
}
function semanticChunk(text, maxSize = 1800, overlap = 300) {
  const paras = text.split(/\n(?=#{1,4}\s|\n\n|```)/);
  const chunks = []; let buf = '';
  for (const p of paras) {
    if (buf.length + p.length < maxSize) { buf += '\n' + p; }
    else {
      if (buf.trim()) chunks.push(buf.trim());
      if (p.length > maxSize) { let i = 0; while (i < p.length) { chunks.push(p.slice(i, i + maxSize)); i += maxSize - overlap; } buf = ''; }
      else { buf = buf.slice(-overlap) + '\n' + p; }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(c => c.length > 40);
}
function rewriteQuery(q) {
  const exps = { fn:'function',func:'function',cfg:'config',err:'error',msg:'message',req:'request',res:'response',db:'database',auth:'authentication',env:'environment' };
  let r = q; for (const [a, f] of Object.entries(exps)) r = r.replace(new RegExp(`\\b${a}\\b`, 'gi'), f);
  return r;
}

// ── Intent/Domain/Complexity ──────────────────────────────────────────────────
function classifyIntent(msg) {
  if (!msg) return 'unknown'; const m = msg.toLowerCase();
  if (/^(fix|debug|error|exception|why (is|does|did)|what('s| is) wrong)/i.test(m)) return 'debug';
  if (/^(write|create|build|make|generate|implement|add)/i.test(m)) return 'create';
  if (/^(explain|what (is|are)|how (does|do)|describe|tell me about)/i.test(m)) return 'explain';
  if (/^(run|execute|check|test|verify)/i.test(m)) return 'execute';
  if (/^(search|find|look up|get|fetch|list)/i.test(m)) return 'retrieve';
  if (/^(refactor|improve|optimize|clean up)/i.test(m)) return 'refactor';
  if (/^(compare|versus|vs|difference between)/i.test(m)) return 'compare';
  if (/thanks|thank you|great|perfect|awesome/i.test(m)) return 'chitchat';
  return 'task';
}
function scoreComplexity(msg, messages = []) {
  if (!msg) return 'simple'; let score = 0;
  if (msg.length > 500) score += 2; else if (msg.length > 200) score += 1;
  if ((msg.match(/\?/g) || []).length >= 2) score += 1;
  if (/\b(and|also|additionally|furthermore)\b/i.test(msg)) score += 1;
  if (/\b(algorithm|architecture|system|design|framework)\b/i.test(msg)) score += 2;
  if (/\b(debug|fix|error|optimize|refactor)\b/i.test(msg)) score += 1;
  if (messages.length > 10) score += 1;
  if (score >= 5) return 'complex'; if (score >= 2) return 'medium'; return 'simple';
}
function detectDomain(msg, messages = []) {
  const text = (msg + ' ' + (messages || []).slice(-3).map(m => m.content || '').join(' ')).toLowerCase();
  if (/\b(function|class|import|const|let|var|async|await|npm|node|python|typescript)\b/.test(text)) return 'coding';
  if (/\b(server|cpu|memory|disk|process|daemon|nginx|docker|kubernetes)\b/.test(text)) return 'sysadmin';
  if (/\b(dataset|dataframe|sql|query|analytics|chart|csv|pandas)\b/.test(text)) return 'data';
  if (/\b(write|essay|blog|content|copy|tone|paragraph|article)\b/.test(text)) return 'writing';
  if (/\b(prove|derive|calculate|integral|matrix|probability|formula)\b/.test(text)) return 'math';
  return 'general';
}
function detectTone(msg) {
  if (!msg) return 'neutral'; const m = msg.toLowerCase();
  if (/(!{2,}|\burgent\b|\basap\b)/.test(m)) return 'urgent';
  if (/(\?\?\?|\bwhy (won't|doesn't|can't)\b|\bstill (not|broken|failing)\b)/.test(m)) return 'frustrated';
  if (/(\bthank|\bgreat|\bperfect|\bawesome)/.test(m)) return 'positive';
  return 'neutral';
}
function getAutoTemp(intent, domain, complexity) {
  if (domain === 'coding' || intent === 'debug' || intent === 'execute') return 0.1;
  if (intent === 'create' || intent === 'explain') return 0.4;
  if (complexity === 'complex') return 0.3;
  return 0.7;
}
function shouldThinkHeuristic(msg) {
  const m = (msg||'').toLowerCase();
  return [
    /\b(prove|derive|calculate|solve|integrate|differentiate|optimize)\b/.test(m),
    /\b(algorithm|complexity|big.?o)\b/.test(m),
    /\b(debug|error|exception|race.?condition)\b/.test(m),
    /\b(design|architect|plan|strategy|trade.?off)\b/.test(m),
    /\b(why|how does|explain in detail|step.?by.?step)\b/.test(m),
    m.length > 300,
    (m.match(/\?/g) || []).length >= 2,
    /\b(compare|contrast|difference between|versus)\b/.test(m),
    /[∫∑∏√∂∇±≈≠≤≥∈]/.test(m),
    /\b(implement|write a|create a|build)\b/.test(m),
  ].filter(Boolean).length >= 3;
}
function scoreResponseQuality(response, query) {
  let score = 100;
  if (!response || response.length < 20) return 10;
  if (/^(Certainly|Of course|Sure!|Great|I'd be happy to)/i.test(response)) score -= 15;
  if (/(Let me know if you need|Hope that helps)/i.test(response)) score -= 10;
  const qT = tokenize(query || ''); const rT = new Set(tokenize(response));
  const cov = qT.filter(t => rT.has(t)).length / Math.max(qT.length, 1);
  score -= Math.round((1 - cov) * 20);
  return Math.max(0, Math.min(100, score));
}
function detectFormatPref(messages = []) {
  const t = (messages || []).filter(m => m.role === 'user').map(m => m.content || '').join(' ');
  if (/```|code|function|class|import/.test(t)) return 'code';
  if (/bullet|list|steps|numbered/.test(t)) return 'bullets';
  return 'prose';
}
function pruneMessages(messages, contextSize = 32768, reserve = 3000) {
  const budget = contextSize - reserve; let total = 0; const result = [];
  // Strip UI-only hidden messages; KEEP _toolResult exec observations.
  // Exec results MUST reach the model so it can answer follow-up questions
  // without hallucinating from training data.
  const clean = messages.filter(m => {
    if (m._hidden) return false;
    if (m._toolResult) return true;           // always keep exec observations
    const c = String(m.content || '');
    if (c.startsWith('[exec result]')) return false;   // legacy pre-_toolResult
    if (c.startsWith('[shell result iter')) return false;
    if (c.startsWith('[ENVIRONMENT BOOT')) return false;
    if (c === 'Environment context loaded. Ready.') return false;
    return true;
  });
  for (let i = clean.length - 1; i >= 0; i--) {
    const t = estimateTokens(clean[i].content || '');
    if (total + t > budget && result.length > 0) break;
    result.unshift(clean[i]); total += t;
  }
  return result;
}
function buildTokenBudget(messages = [], sysPrompt = '', contextSize = 32768) {
  const sys = estimateTokens(sysPrompt);
  const msgs = messages.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
  const used = sys + msgs; const pct = Math.round((used / contextSize) * 100);
  return { used, remaining: contextSize - used, contextSize, pct, nearLimit: pct > 80 };
}

// ── Shell safety ──────────────────────────────────────────────────────────────
function validateCmd(cmd) {
  if (!cmd || typeof cmd !== 'string') return { ok: false, reason: 'Empty command' };
  if (cmd.length > 8000) return { ok: false, reason: 'Command too long' };
  return { ok: true };
}
function classifyToolError(exitCode, output) {
  const o = (output || '').toLowerCase();
  if (exitCode === 0) return 'success';
  if (/permission denied|eacces|not permitted/i.test(o)) return 'permission';
  if (/not found|no such file|command not found|enoent/i.test(o)) return 'not_found';
  if (/timeout|timed out/i.test(o)) return 'timeout';
  if (/connection refused|econnrefused|network/i.test(o)) return 'network';
  if (exitCode === 130 || exitCode === 137) return 'killed';
  return 'logic_error';
}
function detectDestructive(cmd) {
  const patterns = [/\brm\s+-[rRfF]{1,3}/,/\bdrop\s+(table|database)/i,/\bdelete\s+from\b/i,/\btruncate\s+/i,/\bmkfs\./,/\bdd\s+if=/,/\b>(?!>)\s*\/\w/,/\bsudo\s+rm\b/];
  const isDestructive = patterns.some(p => p.test(cmd));
  const risk = cmd.includes('sudo') || cmd.includes('/*') || cmd.includes('-rf') ? 'high' : isDestructive ? 'medium' : 'low';
  return { isDestructive, risk };
}

// ── Text extraction ───────────────────────────────────────────────────────────
const TEXT_EXTS = new Set(['.txt','.md','.mdx','.rst','.log','.csv','.tsv','.json','.jsonl','.xml','.yaml','.yml','.toml','.env','.ini','.cfg','.conf','.js','.mjs','.jsx','.ts','.tsx','.vue','.svelte','.py','.pyw','.rb','.go','.rs','.c','.cpp','.h','.hpp','.cs','.java','.php','.sh','.bash','.zsh','.fish','.ps1','.bat','.cmd','.sql','.graphql','.html','.htm','.css','.scss','.swift','.kt','.dart','.lua','.pl','.r','.asm','.tf','.tex','.bib']);
function extractTextFallbackPDF(buf) {
  const s = buf.toString('binary'); const cs = []; const re = /\(([^)\\]|\\[\s\S])*\)/g; let m;
  while ((m = re.exec(s)) !== null) { const inner = m[0].slice(1,-1).replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\\\/g,'\\').replace(/\\r/g,'').replace(/\\\(/g,'(').replace(/\\\)/g,')'); if (inner.trim().length > 2) cs.push(inner); }
  return cs.length > 50 ? cs.join(' ') : s.replace(/[^\x20-\x7e\n\r\t]/g,' ').replace(/\s{3,}/g,'\n').trim();
}
async function extractText(filename, buf) {
  const ext = require('path').extname(filename).toLowerCase();
  if (TEXT_EXTS.has(ext) || !ext) return buf.toString('utf8');
  if (ext === '.pdf') {
    let pdfParse = null; try { pdfParse = require('pdf-parse'); } catch {}
    if (pdfParse) { try { const data = await pdfParse(buf, { max: 0 }); if (data.text?.trim().length > 50) return data.text; } catch {} }
    return extractTextFallbackPDF(buf);
  }
  if (['.docx','.xlsx','.pptx','.odt'].includes(ext)) return buf.toString('binary').replace(/<[^>]+>/g,' ').replace(/[^\x20-\x7e\n\r\t]/g,' ').replace(/\s{3,}/g,'\n').trim().slice(0,400000);
  const pr = []; let run = '';
  for (let i = 0; i < Math.min(buf.length, 10*1024*1024); i++) { const c = buf[i]; if (c >= 0x20 && c < 0x7f) { run += String.fromCharCode(c); } else { if (run.length >= 5) pr.push(run); run = ''; } }
  if (run.length >= 5) pr.push(run);
  return pr.join('\n');
}

// ── Tool Loop Detection ───────────────────────────────────────────────────────
// Tracks last N exec commands per session; fires when the same cmd repeats.
// Mirrors openclaw loopDetection config.
const _loopWindows = new Map(); // sessionId -> [{cmd, ts}]
const LOOP_WINDOW_MS   = 120_000;
const LOOP_MAX_REPEATS = 4;
function checkToolLoop(sessionId, cmd) {
  if (!cmd || !sessionId) return { loop: false };
  const now2 = Date.now();
  const cutoff = now2 - LOOP_WINDOW_MS;
  let hist = (_loopWindows.get(sessionId) || []).filter(e => e.ts > cutoff);
  hist.push({ cmd: cmd.trim(), ts: now2 });
  if (hist.length > 200) hist = hist.slice(-200);
  _loopWindows.set(sessionId, hist);
  const repeats = hist.filter(e => e.cmd === cmd.trim()).length;
  return repeats >= LOOP_MAX_REPEATS
    ? { loop: true, repeats, cmd: cmd.trim().slice(0, 80) }
    : { loop: false, repeats };
}
function resetLoopDetector(sessionId) { _loopWindows.delete(sessionId); }

// ── Tool Result Truncation Guard ──────────────────────────────────────────────
// Caps oversized tool outputs before they bloat the transcript.
// Mirrors openclaw tool-result-truncation.ts.
const TOOL_RESULT_HARD_CAP = 4_000;
function truncateToolResult(output, cap = TOOL_RESULT_HARD_CAP) {
  if (!output) return { text: '', truncated: false };
  output = output.replace(/<\s*\|[^|]*\|\s*>/g, '').replace(/\n{3,}/g, '\n\n').trim();

  if (output.length <= cap) return { text: output, truncated: false };
  const head = Math.floor(cap * 0.6);
  const tail = cap - head - 80;
  return {
    text: output.slice(0, head) +
      `\n…[TRUNCATED ${output.length - cap} chars — use targeted commands to see more]…\n` +
      output.slice(-Math.max(tail, 0)),
    truncated: true,
    originalLen: output.length
  };
}

// ── Context Window Guard + Compaction helpers ─────────────────────────────────
// Mirrors openclaw context-guard and compaction pipeline.
const COMPACT_THRESHOLD_PCT = 80;

function shouldCompact(tokenBudget) {
  return !!(tokenBudget && tokenBudget.pct >= COMPACT_THRESHOLD_PCT);
}

function buildCompactionPrompt(messages) {
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}: ${(m.content || '').slice(0, 2000)}`)
    .join('\n\n');
  return (
    'You are a summariser. Produce a DENSE, STRUCTURED summary of the conversation below.\n' +
    'Include: key decisions, files touched, commands run, errors encountered, current task state.\n' +
    'Format as bullet points. Under 600 words. Omit padding.\n\n' +
    'CONVERSATION:\n' + transcript.slice(0, 40000)
  );
}

// ── Pre-Compaction Memory Flush prompt ────────────────────────────────────────
// Mirrors openclaw silent agentic turn before compaction fires.
function buildMemoryFlushPrompt() {
  return (
    '[PRE-COMPACTION]\n' +
    'Context is nearly full and will be summarised. Before that happens:\n' +
    '1. Persist any findings worth keeping: POST /api/agent/memory {key, value}\n' +
    '2. Store durable project facts: POST /api/memory {namespace:"project_facts", key, content}\n' +
    '3. If a task is in progress, record where you left off.\n' +
    'Reply with NO_REPLY.'
  );
}

// ── Plan utils ────────────────────────────────────────────────────────────────
function createPlan(task, steps = []) {
  return {
    id: crypto.randomUUID(), task,
    steps: steps.map((s, i) => ({ id: i + 1, description: s.description || s, status: 'pending', dependsOn: s.dependsOn || [], startedAt: null, completedAt: null, result: null })),
    createdAt: Date.now(), status: 'active', currentStep: 0
  };
}
function getPlanSummary(plan) {
  const done = plan.steps.filter(s => s.status === 'done').length;
  const fail = plan.steps.filter(s => s.status === 'failed').length;
  const pend = plan.steps.filter(s => s.status === 'pending').length;
  return `${done}/${plan.steps.length} done, ${pend} pending${fail ? ', ' + fail + ' failed' : ''}`;
}

// ── v17: Reflexion — structured self-critique ─────────────────────────────────
// Based on Shinn et al. Reflexion (2022) & Anthropic/OpenAI agent prompts.
// Generates a verbal self-reflection on a failed/poor response to guide retry.
// Call after getting low quality score or tool error; inject into next turn.
function buildReflexionPrompt(originalQuery, failedResponse, errorContext = '') {
  return (
    '[REFLEXION]\n' +
    'The previous response missed the mark. Figure out why and fix it.\n\n' +
    'Original request: ' + originalQuery.slice(0, 500) + '\n\n' +
    'Your response: ' + (failedResponse || '').slice(0, 1000) + '\n\n' +
    (errorContext ? 'Error / failure signal: ' + errorContext.slice(0, 300) + '\n\n' : '') +
    'Self-critique steps:\n' +
    '1. What exactly went wrong? (factual error, incomplete, wrong format, hallucination?)\n' +
    '2. What is the root cause?\n' +
    '3. What would a better response look like?\n' +
    '4. State your improved approach in one sentence.\n\n' +
    'Then produce the improved response directly — don\'t just describe what you plan to do.'
  );
}

// ── v17: Context rot detection ────────────────────────────────────────────────
// Earlier threshold (60%) prevents performance degradation before it hits.
// Research shows models start losing accuracy around 60-70% context fullness.
const CONTEXT_ROT_THRESHOLD_PCT = 60;
const CONTEXT_CRITICAL_PCT = 85;
function detectContextRot(tokenBudget) {
  if (!tokenBudget) return { rot: false, critical: false, level: 'ok' };
  if (tokenBudget.pct >= CONTEXT_CRITICAL_PCT) return { rot: true, critical: true, level: 'critical' };
  if (tokenBudget.pct >= CONTEXT_ROT_THRESHOLD_PCT) return { rot: true, critical: false, level: 'warning' };
  return { rot: false, critical: false, level: 'ok' };
}

// ── v17: Observation masking for compaction ───────────────────────────────────
// Based on JetBrains/Lindenbauer et al. NeurIPS 2025 research.
// During compaction, keep action + reasoning but mask/truncate tool observations.
// Preserves model's "rhythm" and formatting style. More reversible than full summarize.
// keepRawTurns: how many recent turns to keep verbatim (default 3 = Manus pattern).
function buildCompactionPromptV17(messages, keepRawTurns = 3) {
  if (!messages || !messages.length) return '';
  const recent = messages.slice(-keepRawTurns);
  const older = messages.slice(0, -keepRawTurns);
  
  // Observation masking: for older turns, truncate very long tool outputs
  const maskedOlder = older.map(m => {
    const content = (m.content || '');
    // If an assistant message has a large exec output block, mask it
    const maskedContent = content.replace(
      /(\[exec\]|\`\`\`exec[\s\S]*?\`\`\`|Output:[\s\S]{500,}?(?=\n\n|\n[A-Z]|$))/g,
      '[tool-output masked for compaction]'
    ).slice(0, 1500);
    return `${m.role.toUpperCase()}: ${maskedContent}`;
  });

  const transcript = maskedOlder.join('\n\n');
  return (
    'You are a summariser for an AI agent session. Produce a DENSE, STRUCTURED summary.\n' +
    'PRESERVE: key decisions, files written, errors resolved, current task state, user preferences stated.\n' +
    'OMIT: raw tool outputs, repetitive iterations, superseded plans.\n' +
    'Format as bullet points grouped by: [DECISIONS] [FILES] [ERRORS] [STATE] [PREFS].\n' +
    'Under 600 words. Omit padding.\n\n' +
    'NOTE: The ' + recent.length + ' most recent turns will be kept verbatim — do NOT include them.\n\n' +
    'OLDER TURNS TO SUMMARISE:\n' + transcript.slice(0, 40000)
  );
}

// ── v17: Todo checklist helpers (Manus pattern) ───────────────────────────────
// Structured task tracking with markdown-style markers.
// AI creates a todo.md at task start, updates it per iteration.
function formatTodoList(todos = []) {
  if (!todos.length) return '';
  return todos.map(t => {
    const marker = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
    return `${marker} ${t.description}`;
  }).join('\n');
}
function parseTodoList(text = '') {
  return text.split('\n').map(line => {
    const m = line.match(/^\[(x|~| )\]\s+(.+)/);
    if (!m) return null;
    return { status: m[1] === 'x' ? 'done' : m[1] === '~' ? 'in_progress' : 'pending', description: m[2].trim() };
  }).filter(Boolean);
}

// ── v17: Tool safety pre-scoring ──────────────────────────────────────────────
// Scores a command's risk level 0-100 before execution.
// Combines detectDestructive + new heuristics from OWASP LLM Top 10 2025.
function scoreToolSafety(cmd = '') {
  const { isDestructive, risk } = detectDestructive(cmd);
  let score = 0;
  if (risk === 'high')   score += 50;
  if (risk === 'medium') score += 25;
  if (/curl\s+.*(POST|PUT|DELETE|PATCH)/i.test(cmd)) score += 20; // network write
  if (/>\s*\/etc|>\s*\/root|>\s*\/sys/i.test(cmd))   score += 30; // writing to system dirs
  if (/chmod\s+[0-7]*7[0-7]{2}|chmod\s+\+x/i.test(cmd)) score += 15; // executable perms
  if (/eval\s*\(|base64\s+-d/i.test(cmd)) score += 25; // code exec patterns
  if (/\|\s*(bash|sh|zsh|python)\s*$/i.test(cmd)) score += 20; // piping to shell
  if (cmd.length > 500) score += 10; // unusually long commands
  return { score: Math.min(100, score), risk, isDestructive, requiresNotice: score >= 30 };
}

// ── v17: Response format quality check ───────────────────────────────────────
// Penalize excessive bullet points in conversational/prose responses.
// From Claude official prompts: prose not bullets for explanations.
function scoreResponseFormat(response = '', domain = 'general', intent = 'task') {
  const lines = response.split('\n');
  const bulletLines = lines.filter(l => /^\s*[-*•]\s/.test(l) || /^\s*\d+\.\s/.test(l)).length;
  const bulletRatio = bulletLines / Math.max(lines.length, 1);
  let penalty = 0;
  // Bullets are fine for code/data/lists, but not for prose domains
  if (!['coding','data'].includes(domain) && intent !== 'retrieve' && bulletRatio > 0.5) {
    penalty = Math.round(bulletRatio * 20);
  }
  return { bulletRatio: Math.round(bulletRatio * 100), penalty, overFormatted: penalty > 10 };
}


module.exports = {
  tokenize, cosineSim, estimateTokens, validateStr, sanitizeFilename, redactSensitive,
  detectInjection, hashText, safeParseJSON, tfVector, bm25, semanticChunk, rewriteQuery,
  classifyIntent, scoreComplexity, detectDomain, detectTone, getAutoTemp,
  shouldThinkHeuristic, scoreResponseQuality, detectFormatPref,
  pruneMessages, buildTokenBudget, validateCmd, classifyToolError, detectDestructive,
  extractText, createPlan, getPlanSummary,
  // openclaw-derived techniques
  checkToolLoop, resetLoopDetector,
  truncateToolResult, TOOL_RESULT_HARD_CAP,
  shouldCompact, COMPACT_THRESHOLD_PCT,
  buildCompactionPrompt, buildMemoryFlushPrompt,
  // v17 additions
  buildReflexionPrompt,
  detectContextRot, CONTEXT_ROT_THRESHOLD_PCT, CONTEXT_CRITICAL_PCT,
  buildCompactionPromptV17,
  formatTodoList, parseTodoList,
  scoreToolSafety,
  scoreResponseFormat,
};
