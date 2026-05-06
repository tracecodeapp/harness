int solve(vector<vector<int>>& rows) {
  vector<vector<int>> values;
  for (auto& row : rows) {
    values.push_back(row);
  }
  int total = values[0][1] + values[1][0];
  return total;
}
