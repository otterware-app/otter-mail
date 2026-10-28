/**
 * Minimal diff for showing how two versions of a draft differ (conflict
 * view). Word-level for prose; falls back to line-level for long texts so the
 * O(n·m) comparison stays cheap.
 */

export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

/** Above this many token pairs, compare lines instead of words. */
const WORD_DIFF_LIMIT = 2_000_000;

/** Words with their trailing whitespace ("launch "), so a change reads as
    whole words and joining the parts restores the text exactly. */
function tokenize(text: string, byLine: boolean): string[] {
  return byLine ? text.split(/(?<=\n)/) : (text.match(/^\s+|\S+\s*/g) ?? []);
}

/** Diff from `before` to `after`: "added" is only in after, "removed" only in before. */
export function diffText(before: string, after: string): DiffPart[] {
  let a = tokenize(before, false);
  let b = tokenize(after, false);
  if (a.length * b.length > WORD_DIFF_LIMIT) {
    a = tokenize(before, true);
    b = tokenize(after, true);
  }

  // Longest common subsequence table, filled from the end.
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("removed", a[i++]);
    } else {
      push("added", b[j++]);
    }
  }
  while (i < n) push("removed", a[i++]);
  while (j < m) push("added", b[j++]);
  return parts;
}
