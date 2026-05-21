class Solution {
public:
  int solve(vector<int> parent, int x) {
    if (parent[x] != x) parent[x] = x;
    return parent[x];
  }
};
