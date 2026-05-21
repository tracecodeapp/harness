class Solution {
public:
  int solve(int n) {
    auto count = [&](auto&& self, int value) -> int {
      if (value == 0) return 0;
      return 1 + self(self, value - 1);
    };
    return count(count, n);
  }
};
