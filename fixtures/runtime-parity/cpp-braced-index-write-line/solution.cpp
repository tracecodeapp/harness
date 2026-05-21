class Solution {
public:
  int solve(unordered_map<string, string> parent, string x, string root) {
    if (parent[x] != x) {
      parent[x] = root;
    }
    return parent[x].size();
  }
};
