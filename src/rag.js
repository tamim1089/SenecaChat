'use strict';
const { getDocs, getAllChunks } = require('./db/index');
const { tokenize } = require('./utils/index');

// ─── BM25 ─────────────────────────────────────────────────────────────────────
function tfVector(t) {
  const tokens = tokenize(t); const freq = {};
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

function cosineSim(a, b) {
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
  const inter = [...ta].filter(t => tb.has(t)).length;
  if (!ta.size || !tb.size) return 0;
  return inter / Math.sqrt(ta.size * tb.size);
}

// ─── CHUNKING ─────────────────────────────────────────────────────────────────
function semanticChunk(text, maxSize = 1800, overlap = 300) {
  const paras = text.split(/\n(?=#{1,4}\s|\n\n|```)/);
  const chunks = []; let buf = '';
  for (const p of paras) {
    if (buf.length + p.length < maxSize) { buf += '\n' + p; }
    else {
      if (buf.trim()) chunks.push(buf.trim());
      if (p.length > maxSize) {
        let i = 0;
        while (i < p.length) { chunks.push(p.slice(i, i + maxSize)); i += maxSize - overlap; }
        buf = '';
      } else { buf = buf.slice(-overlap) + '\n' + p; }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(c => c.length > 40);
}

// ─── QUERY REWRITING ──────────────────────────────────────────────────────────
function rewriteQuery(q) {
  const exps = { fn: 'function', func: 'function', cfg: 'config', err: 'error', msg: 'message', req: 'request', res: 'response', db: 'database', auth: 'authentication', env: 'environment' };
  let r = q;
  for (const [a, f] of Object.entries(exps)) r = r.replace(new RegExp(`\\b${a}\\b`, 'gi'), f);
  return r;
}

// ─── HYBRID SEARCH ────────────────────────────────────────────────────────────
function hybridSearch(query, topK = 8, hybrid = false) {
  const allChunks = getAllChunks();
  if (!allChunks.length) return [];
  const rewritten = rewriteQuery(query);
  const qT = tokenize(rewritten);
  if (!qT.length) return [];
  const N = allChunks.length;
  const avgLen = allChunks.reduce((s, c) => s + (c.len || 0), 0) / N;
  const df = {};
  for (const c of allChunks) for (const t of Object.keys(c.freq || {})) df[t] = (df[t] || 0) + 1;

  const scored = allChunks.map(c => {
    const b = bm25(qT, c.freq || {}, c.len || 1, avgLen, N, df);
    const sem = hybrid ? cosineSim(rewritten, c.text) * 2 : 0;
    // Freshness bonus
    const ageDays = (Date.now() - (c.ingested_at || 0)) / (1000 * 60 * 60 * 24);
    const freshBonus = Math.max(0, 1 - ageDays / 365) * 0.1;
    return { filename: c.filename, relPath: c.rel_path, text: c.text, idx: c.idx, score: b + sem + freshBonus };
  }).filter(c => c.score > 0);

  scored.sort((a, b) => b.score - a.score);

  const seen = new Map(); const result = [];
  for (const r of scored) {
    const cnt = seen.get(r.filename) || 0;
    if (cnt < 3) { result.push(r); seen.set(r.filename, cnt + 1); }
    if (result.length >= topK) break;
  }
  const maxScore = result[0]?.score || 1;
  result.forEach(r => { r.confidence = Math.round((r.score / maxScore) * 100); });
  return result;
}

// ─── RE-RANKING ───────────────────────────────────────────────────────────────
function rerankChunks(chunks, query) {
  if (!chunks || !chunks.length) return chunks;
  const qTokens = new Set(tokenize(query));
  return chunks.map(c => {
    const exactBonus = query.toLowerCase().split(' ').filter(w => w.length > 3).every(w => (c.text || '').toLowerCase().includes(w)) ? 1.5 : 1;
    const posBonus = c.idx < 3 ? 1.1 : 1;
    const density = [...qTokens].filter(t => new Set(tokenize(c.text || '')).has(t)).length / Math.max(qTokens.size, 1);
    return { ...c, rerankScore: (c.confidence || 50) * exactBonus * posBonus * (1 + density * 0.5) };
  }).sort((a, b) => b.rerankScore - a.rerankScore);
}

function addSourceCitations(chunks) {
  return chunks.map((c, i) => ({
    ...c,
    citation: `[${i + 1}] ${c.filename}${c.idx !== undefined ? ` §${c.idx + 1}` : ''}`,
    citationShort: `[${i + 1}]`
  }));
}

module.exports = { tfVector, bm25, cosineSim, semanticChunk, rewriteQuery, hybridSearch, rerankChunks, addSourceCitations };
