function solve() {
  const seen = new Map([[2, 5]]);
  seen.delete(2);
  return seen.size;
}
