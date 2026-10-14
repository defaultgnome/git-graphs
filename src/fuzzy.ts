// case-insensitive subsequence match; higher is better, null when q isn't a subsequence of s.
// ponytail: greedy (first occurrence), not optimal alignment; swap for fuzzysort if ranking ever feels off
export function fuzzy(q: string, s: string): number | null {
  q = q.toLowerCase().replace(/\s+/g, "");
  s = s.toLowerCase();
  let score = 0, j = 0, prev = -2;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) continue;
    // runs beat word starts beat scattered letters
    score += i === prev + 1 ? 3 : /[\s._@<-]/.test(s[i - 1] ?? " ") ? 2 : 1;
    prev = i;
    j++;
  }
  return j === q.length ? score - s.length / 1000 : null;
}
