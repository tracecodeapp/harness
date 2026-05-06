int solve(vector<vector<int>>& grid) {
  int total = 0;
  for (int i = 0; i < grid.size(); i++) {
    for (int j = 0; j < grid[i].size(); j++) {
      total += grid[i][j];
    }
  }
  return total;
}
