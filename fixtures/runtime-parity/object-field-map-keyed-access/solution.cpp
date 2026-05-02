struct Node {
  unordered_map<string, int> children;
};

class Solution {
public:
  int solve(string key) {
    Node node;
    node.children[key] = 1;
    return node.children[key];
  }
};
