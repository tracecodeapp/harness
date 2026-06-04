class Solution {
  public int solve(String s, int[] nums) {
    int right = 2;
    int left = 0;
    int best = 0;
    char ch = s.charAt(right);
    int picked = nums[right];
    best = Math.max(best, right - left + 1);
    return best + picked + (ch == '\0' ? 0 : 1);
  }
}
