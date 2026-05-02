class Solution {
public:
  int solve(int n) {
    int total = 0;
    int i = 0;
    while (i < n) {
      total += i;
      i++;
    }
    return total;
  }
};
