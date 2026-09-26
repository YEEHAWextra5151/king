/**
 * Xcode-style fuzzy matching for Open Quickly: the query's characters must
 * appear in order; contiguous runs, word starts and file-name matches score
 * higher. Returns null for no match, and the matched indices for bolding.
 */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const SEPARATORS = new Set(["/", "-", "_", ".", " "]);

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // Prefer the best of a few alignments: greedy from each occurrence of
  // the first character.
  let best: FuzzyMatch | null = null;
  let start = t.indexOf(q[0]);
  let attempts = 0;
  while (start >= 0 && attempts < 8) {
    const m = align(q, t, target, start);
    if (m && (!best || m.score > best.score)) best = m;
    start = t.indexOf(q[0], start + 1);
    attempts++;
  }
  return best;
}

function align(q: string, t: string, original: string, start: number): FuzzyMatch | null {
  const indices: number[] = [];
  let score = 0;
  let ti = start;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found < 0) return null;
    indices.push(found);
    let s = 1;
    if (found === prev + 1) s += 5; // contiguous
    const before = found > 0 ? original[found - 1] : "/";
    if (SEPARATORS.has(before)) s += 4; // word start
    else if (original[found] !== original[found].toLowerCase() && before === before.toLowerCase()) s += 3; // camelCase hump
    if (original[found] === q[qi]) s += 0.2; // exact case
    score += s;
    prev = found;
    ti = found + 1;
  }
  // Tighter spans and shorter targets rank higher.
  const span = indices[indices.length - 1] - indices[0] + 1;
  score -= (span - q.length) * 0.15;
  score -= t.length * 0.01;
  return { score, indices };
}

/** Scores a path, weighting matches in the file name above the folders. */
export function fuzzyPath(query: string, name: string, path: string): FuzzyMatch | null {
  const nameMatch = fuzzyMatch(query, name);
  if (nameMatch) return { score: nameMatch.score * 2 + 10, indices: nameMatch.indices };
  const pathMatch = fuzzyMatch(query, path);
  return pathMatch ? { score: pathMatch.score, indices: [] } : null;
}
