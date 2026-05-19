class Solution {
  public int solve(String[] board) {
    int count = 0;
    for (int r = 0; r < board.length; r++) {
      for (int c = 0; c < board[r].length(); c++) {
        if (board[r].charAt(c) == '.') {
          count += 1;
        }
      }
    }
    return count;
  }
}
