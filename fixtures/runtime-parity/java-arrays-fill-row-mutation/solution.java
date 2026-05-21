import java.util.Arrays;

class Solution {
  public char[][] solve(int n) {
    char[][] board = new char[n][n];
    for (int r = 0; r < n; r++) {
      Arrays.fill(board[r], '.');
    }
    return board;
  }
}
