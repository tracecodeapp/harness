function solve() {
  const seen = new Map();
  seen.set(2, 5);
  seen.delete(2);
  return seen.size;
}
