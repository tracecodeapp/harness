class Solution {
  public int solve() {
    int[][] grid = new int[][]{{0, 0}, {0, 0}};
    grid[1][0] += 1;
    return grid[1][0];
  }
}
