class Solution {
  public int solve(int[][] grid) {
    int total = 0;
    for (int i = 0; i < grid.length; i++) {
      for (int j = 0; j < grid[i].length; j++) {
        total += grid[i][j];
      }
    }
    return total;
  }
}
