class Solution {
public:
  int solve() {
    unordered_map<int, int> seen;
    seen[2] = 5;
    seen.erase(2);
    return seen.size();
  }
};
