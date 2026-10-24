/**
 * Character-level diff for the reading diff view.
 *
 * A page edit stores full old/new lines; this splits one changed line into
 * same / removed / added runs. Prefix and suffix are trimmed first, and the
 * remaining middle is diffed with an LCS so a typo becomes one red character
 * and one green character, not a whole red line and a whole green line.
 *
 * Lines are short (corpus p99 < 100 chars), but a pasted line can be long; if
 * the middle exceeds the cap we fall back to "remove old middle / add new
 * middle" instead of allocating a huge table.
 */
export type CharSeg = { kind: 'same' | 'del' | 'ins'; text: string };

const MAX_CELLS = 250_000;

export function charDiff(oldText: string, newText: string): CharSeg[] {
  if (oldText === newText) return oldText ? [{ kind: 'same', text: oldText }] : [];
  const a = Array.from(oldText);
  const b = Array.from(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);

  let mid: CharSeg[];
  if (am.length === 0) mid = bm.length ? [{ kind: 'ins', text: bm.join('') }] : [];
  else if (bm.length === 0) mid = [{ kind: 'del', text: am.join('') }];
  else if (am.length * bm.length > MAX_CELLS) {
    mid = [{ kind: 'del', text: am.join('') }, { kind: 'ins', text: bm.join('') }];
  } else {
    mid = lcsDiff(am, bm);
  }

  const out: CharSeg[] = [];
  if (p) out.push({ kind: 'same', text: a.slice(0, p).join('') });
  out.push(...mid);
  if (s) out.push({ kind: 'same', text: a.slice(a.length - s).join('') });
  return coalesce(out);
}

function lcsDiff(a: string[], b: string[]): CharSeg[] {
  const n = a.length, m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: CharSeg[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ kind: 'del', text: a[i] }); i++; }
    else { out.push({ kind: 'ins', text: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'ins', text: b[j++] });
  return out;
}

function coalesce(segs: CharSeg[]): CharSeg[] {
  const out: CharSeg[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}
