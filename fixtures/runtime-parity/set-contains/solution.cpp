bool solve() {
  unordered_set<int> seen;
  seen.insert(2);
  return seen.count(2) > 0;
}
