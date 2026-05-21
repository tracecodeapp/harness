function solve() {
  const first = { __id__: 'n0', value: 1 };
  const seen = new Set();
  seen.add(first);
  return seen.has(first);
}
