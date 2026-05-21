class Solution {
public:
  int solve(vector<string>& board) {
    int count = 0;
    for (int r = 0; r < (int)board.size(); r++) {
      for (int c = 0; c < (int)board[r].size(); c++) {
        if (board[r][c] == '.') {
          count += 1;
        }
      }
    }
    return count;
  }
};
