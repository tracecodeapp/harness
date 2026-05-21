class Solution {
  public int solve(int n) {
    return helper(1, n);
  }

  private int helper(
      int value,
      int limit
  ) {
    if (value >= limit) {
      return value;
    }
    return helper(value + 1, limit);
  }
}
