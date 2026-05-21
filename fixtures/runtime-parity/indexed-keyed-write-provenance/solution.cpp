class Solution {
public:
  int solve(vector<string>& items) {
    unordered_map<string, int> seen;
    for (const auto& item : items) {
      seen[item] = (int)item.size();
    }
    return seen[items[0]];
  }
};
