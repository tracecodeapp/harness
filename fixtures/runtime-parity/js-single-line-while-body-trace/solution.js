function solve() {
  const t = ['a', 'b'];
  const lps = [0, 0];
  const i = 0;
  let j = 1;
  while (j > 0 && t[i] !== t[j]) j = lps[j - 1];
  return j;
}
