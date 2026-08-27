// Reads what's already on disk in ~/.claude/projects/**/*.jsonl. Nothing here
// writes to a transcript or talks to a session directly — Sidecar only ever
// looks. A lightweight "tail scan" (last few hundred KB of a file) is enough
// for the rail: title, last status, last few turns. A full-file pass is only
// done on demand, for the usage panel, and cached by mtime+size so an
// untouched multi-megabyte session is never re-parsed for nothing.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { costOf } = require('./pricing');
const { diffLines, toHunks, summarize } = require('./diff');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 500_000;
const MAX_TAIL_BYTES = 8_000_000;   // ceiling for "load more" — a few thousand turns
const TURNS_PER_PAGE = 60;
const IDLE_AFTER_MS = 20 * 60 * 1000; // no activity for 20min reads as idle, not "waiting on you"
const ASK_TOOL_RE = /ask.*question/i;

function readTailText(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // if we didn't start at byte 0, the first line is very likely a partial
    // record from mid-file — drop it rather than risk a bad JSON.parse
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* partial or corrupt line — skip */ }
  }
  return out;
}

function contentKinds(content) {
  if (Array.isArray(content)) return content.map((c) => c.type);
  return ['text'];
}

function findAskQuestion(record) {
  const content = record.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type === 'tool_use' && ASK_TOOL_RE.test(block.name || '')) {
      const q = block.input?.questions?.[0] || block.input;
      if (q && (q.question || q.options)) {
        return {
          question: q.question || q.header || 'Waiting on your answer',
          options: (q.options || []).map((o) => ({
            label: o.label || String(o),
            description: o.description || '',
          })),
        };
      }
      return { question: 'Waiting on your answer', options: [] };
    }
  }
  return null;
}

function textOf(record) {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  return '';
}

function toolCallsOf(record) {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: c.input }));
}

function summarizeToolInput(name, input) {
  if (!input) return '';
  if (input.file_path) return path.basename(input.file_path);
  if (input.pattern) return input.pattern;
  if (input.command) return String(input.command).slice(0, 60);
  return '';
}

// One tail read, producing everything the rail and reader need for one session.
// `depth` lets the reader ask for progressively more history when you scroll
// up, instead of being permanently capped at the most recent handful of turns.
function tailScan(filePath, depth = 1) {
  const stat = fs.statSync(filePath);
  const bytes = Math.min(TAIL_BYTES * Math.max(1, depth), MAX_TAIL_BYTES);
  const text = readTailText(filePath, bytes);
  const records = parseLines(text);

  let aiTitle = '', lastPrompt = '', cwd = '', sessionId = '';
  const turns = [];
  const msgRecords = [];

  for (const r of records) {
    if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
    if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.cwd) cwd = r.cwd;
    if (r.sessionId) sessionId = r.sessionId;
    if (r.type === 'assistant' || r.type === 'user') msgRecords.push(r);
  }

  for (const r of msgRecords) {
    const kinds = contentKinds(r.message?.content);
    if (r.type === 'assistant') {
      const think = kinds.includes('thinking');
      const tools = toolCallsOf(r);
      const text = textOf(r);
      if (think) turns.push({ kind: 'thinking' });
      for (const t of tools) turns.push({ kind: 'tool', name: t.name, detail: summarizeToolInput(t.name, t.input) });
      if (text) turns.push({ kind: 'assistant', text });
    } else if (r.type === 'user') {
      if (kinds.includes('tool_result')) continue; // noise for the reader — the tool line above already says what ran
      const text = textOf(r);
      const hasImage = kinds.includes('image');
      if (text || hasImage) turns.push({ kind: 'user', text, hasImage });
    }
  }

  const last = msgRecords[msgRecords.length - 1];
  let status = 'idle';
  let ask = null;
  if (last) {
    const kinds = contentKinds(last.message?.content);
    const age = Date.now() - stat.mtimeMs;
    if (last.type === 'assistant' && kinds.includes('tool_use')) {
      ask = findAskQuestion(last);
      status = ask ? 'ask' : 'running';
    } else if (last.type === 'user' && kinds.includes('tool_result')) {
      status = 'running';
    } else if (last.type === 'assistant') {
      // A record holding only a thinking block means Claude is mid-thought and
      // hasn't written anything yet. That used to fall through to 'wait', so a
      // session that was busy thinking claimed it was waiting on *you*.
      const onlyThinking = kinds.includes('thinking') && !kinds.includes('text');
      if (onlyThinking && age < IDLE_AFTER_MS) status = 'thinking';
      else status = age < IDLE_AFTER_MS ? 'wait' : 'idle';
    } else if (last.type === 'user') {
      // Your message is the newest thing in the file — Claude hasn't replied yet.
      status = age < IDLE_AFTER_MS ? 'thinking' : 'idle';
    } else {
      status = 'idle';
    }
  }

  return {
    aiTitle, lastPrompt, cwd, sessionId,
    status, ask,
    turns: turns.slice(-TURNS_PER_PAGE * Math.max(1, depth)),
    // true when older turns exist beyond what was returned
    hasMore: turns.length > TURNS_PER_PAGE * Math.max(1, depth) || bytes < stat.size,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    lineCount: records.length, // tail-relative; used only as a same-file "has it changed" signal
  };
}

// Full-file usage pass, cached by mtime+size so unchanged sessions are free
// on repeat calls. Only invoked when the usage panel actually needs a number.
const usageCache = new Map(); // filePath -> {key, usage}

function fullUsageScan(filePath) {
  const stat = fs.statSync(filePath);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = usageCache.get(filePath);
  if (cached && cached.key === key) return cached.usage;

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUSD: 0 };
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    const u = r.message?.usage;
    if (!u) continue;
    totals.input += u.input_tokens || 0;
    totals.output += u.output_tokens || 0;
    totals.cacheRead += u.cache_read_input_tokens || 0;
    totals.cacheWrite += u.cache_creation_input_tokens || 0;
    totals.thinking += u.output_tokens_details?.thinking_tokens || 0;
    totals.costUSD += costOf(u, r.message?.model);
  }
  usageCache.set(filePath, { key, usage: totals });
  return totals;
}

// The edits a session actually made, reconstructed from its Edit/Write tool
// calls. This is history, not a pending IDE diff — the extension exposes no
// way to read the diff it currently has open, only to accept or reject it.
function recentEdits(filePath, limit = 12) {
  const records = parseLines(readTailText(filePath, TAIL_BYTES));
  const edits = [];

  for (const r of records) {
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const name = block.name || '';
      const input = block.input || {};
      if (!input.file_path) continue;

      if (/^Edit$/i.test(name) && typeof input.new_string === 'string') {
        const rows = toHunks(diffLines(input.old_string, input.new_string));
        edits.push({
          kind: 'edit',
          file: input.file_path,
          name: path.basename(input.file_path),
          rows,
          ...summarize(rows),
        });
      } else if (/^Write$/i.test(name) && typeof input.content === 'string') {
        const lines = input.content.split('\n');
        const rows = lines.slice(0, 400).map((s) => ({ t: 'add', s }));
        if (lines.length > 400) rows.push({ t: 'gap', s: `⋯ ${lines.length - 400} more lines` });
        edits.push({
          kind: 'write',
          file: input.file_path,
          name: path.basename(input.file_path),
          rows,
          added: lines.length,
          removed: 0,
        });
      }
    }
  }

  return edits.slice(-limit).reverse(); // newest first
}

function projectDirs() {
  try { return fs.readdirSync(PROJECTS_DIR); } catch (e) { return []; }
}

function sessionFilesIn(projectDir) {
  const dir = path.join(PROJECTS_DIR, projectDir);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch (e) { return []; }
}

function listAllSessionFiles() {
  const out = [];
  for (const d of projectDirs()) out.push(...sessionFilesIn(d));
  return out;
}

module.exports = {
  PROJECTS_DIR,
  tailScan,
  fullUsageScan,
  listAllSessionFiles,
  recentEdits,
};
