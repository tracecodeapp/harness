class Solution {
  public int solve(int[] nums) {
    int total = 0;
    for (int left = 0; left < nums.length;) {
      total += nums[left];
      left += 2;
    }
    return total;
  }
}
