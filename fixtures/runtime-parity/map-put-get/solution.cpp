class Solution {
public:
  int solve() {
    unordered_map<int, int> seen;
    seen[2] = 5;
    return seen[2];
  }
};
