int solve(vector<vector<int>>& matrix, vector<string>& pizza) {
  int cols = matrix[0].size();
  int width = pizza[0].size();
  return cols + width;
}
