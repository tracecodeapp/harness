int solve(string text) {
  vector<int> counts(26, 0);
  int base = 'a';
  for (int i = 0; i < (int)text.size(); i++) {
    counts[text[i] - base]++;
  }
  return counts[0];
}
