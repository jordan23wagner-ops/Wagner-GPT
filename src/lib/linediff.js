// Wagner-GPT — tiny line-level diff (Phase 8, dependency-free)
//
// Classic LCS over lines, emitted as a flat list of rows for the confirm view:
//   { type: 'same' | 'add' | 'del', text }
// Good enough to show a before/after of a single edited file. Not optimized for huge
// files, but Coding Mode files are source files, so this is fine.

export function diffLines(oldText, newText) {
  const a = String(oldText).split('\n')
  const b = String(newText).split('\n')
  const n = a.length
  const m = b.length

  // LCS length table.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] }); i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] }); i++
    } else {
      rows.push({ type: 'add', text: b[j] }); j++
    }
  }
  while (i < n) { rows.push({ type: 'del', text: a[i] }); i++ }
  while (j < m) { rows.push({ type: 'add', text: b[j] }); j++ }
  return rows
}

// Summary counts for a quick "+3 −1" badge.
export function diffStats(rows) {
  let add = 0
  let del = 0
  for (const r of rows) {
    if (r.type === 'add') add++
    else if (r.type === 'del') del++
  }
  return { add, del }
}
