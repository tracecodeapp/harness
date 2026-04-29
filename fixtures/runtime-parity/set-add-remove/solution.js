function solve() {
  const seen = new Set();
  seen.add(2);
  seen.delete(2);
  return seen.size;
}
