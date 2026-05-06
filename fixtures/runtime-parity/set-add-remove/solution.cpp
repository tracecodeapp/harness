class Solution {
public:
  int solve() {
    unordered_set<int> seen;
    seen.insert(2);
    seen.erase(2);
    return seen.size();
  }
};
