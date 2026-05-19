class Solution {
public:
  int solve(vector<int>& values) {
    int total = 0;
    for (int value : values) {
      total += value;
    }
    return total;
  }
};
