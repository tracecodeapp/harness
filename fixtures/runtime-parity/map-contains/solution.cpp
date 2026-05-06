class Solution {
public:
  bool solve() {
    unordered_map<int, int> seen;
    seen[2] = 5;
    return seen.count(2);
  }
};
