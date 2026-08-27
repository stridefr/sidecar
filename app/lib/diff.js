// Line diff for the edits recorded in a transcript. Edit tool calls carry
// old_string and new_string verbatim, so a real before/after can be rendered
// without touching the working tree or asking the IDE for anything.
//
// These snippets are small (a hunk, not a file), so a plain LCS is fine — with
// a guard so a pathological pair falls back to "replace wholesale" instead of
// allocating a huge table.
const MAX_CELLS = 400_000;

function lcsDiff(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ t: 'ctx', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: a[i] }); i++; }
    else { out.push({ t: 'add', s: b[j] }); j++; }
  }
  while (i < m) out.push({ t: 'del', s: a[i++] });
  while (j < n) out.push({ t: 'add', s: b[j++] });
  return out;
}

function diffLines(oldStr, newStr) {
  const a = String(oldStr ?? '').split('\n');
  const b = String(newStr ?? '').split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((s) => ({ t: 'del', s })), ...b.map((s) => ({ t: 'add', s }))];
  }
  return lcsDiff(a, b);
}

// Trims long unchanged runs down to `pad` lines either side of each change,
// inserting a gap marker where lines were elided.
function toHunks(rows, pad = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.t === 'ctx') return;
    for (let k = Math.max(0, i - pad); k <= Math.min(rows.length - 1, i + pad); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ t: 'gap', s: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` }); skipped = 0; }
      out.push(r);
    } else skipped++;
  });
  if (skipped) out.push({ t: 'gap', s: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}

function summarize(rows) {
  let added = 0, removed = 0;
  for (const r of rows) {
    if (r.t === 'add') added++;
    else if (r.t === 'del') removed++;
  }
  return { added, removed };
}

module.exports = { diffLines, toHunks, summarize };
