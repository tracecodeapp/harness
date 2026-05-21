struct Node {
  unordered_map<char, int> children;
};

class Solution {
public:
  int solve(vector<vector<char>> board, char key) {
    Node node;
    node.children[key] = 1;
    if (board.size() > 0 && board[0].size() > 0 && node.children.count(key)) return 1;
    return 0;
  }
};
