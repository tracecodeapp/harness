class Solution {
public:
  int solve(vector<vector<int>>& grid) {
    int value = grid[0][1]; tracecode::emit_snapshot_value("value", value, tracecode::current_trace_line());
    grid[1][0] = value + grid[0][0];
    return grid[1][0];
  }
};
