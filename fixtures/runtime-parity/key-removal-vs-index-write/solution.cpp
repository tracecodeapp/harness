int solve() {
  unordered_map<string, int> counts{{"a", 2}, {"b", 1}};
  counts["a"] = counts["a"] - 1;
  counts.erase("b");
  return counts.at("a") + counts.size();
}
