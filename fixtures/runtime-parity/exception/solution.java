class Solution {
  public int fail() {
    throw new IllegalArgumentException("bad input");
  }

  public int solve(int n) {
    try {
      fail();
    } catch (IllegalArgumentException error) {
      return n;
    }
    return n;
  }
}
