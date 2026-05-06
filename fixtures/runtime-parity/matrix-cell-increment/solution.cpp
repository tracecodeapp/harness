int solve() {
  vector<vector<int>> grid{{0, 0}, {0, 0}};
  grid[1][0] += 1;
  return grid[1][0];
}
