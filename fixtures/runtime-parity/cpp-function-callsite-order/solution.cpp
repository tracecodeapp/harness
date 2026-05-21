class Solution {
public:
  int helper(int x) {
    return x + 1;
  }

  int solve(int n) {
    int value = n;
    value = helper(value);
    return value;
  }
};
