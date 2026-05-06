void appendValue(vector<int>& out, int value) {
  out.push_back(value);
}

vector<int> solve(int value) {
  vector<int> out;
  appendValue(out, value);
  return out;
}
