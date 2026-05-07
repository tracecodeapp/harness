class Solution {
  public int[][] solve(int[][] grid) {
    grid[0][1]++;
    --grid[1][0];
    return grid;
  }
}
