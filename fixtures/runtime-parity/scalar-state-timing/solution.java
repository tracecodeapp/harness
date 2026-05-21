class Solution {
  public int solve(int[] nums) {
    int left = 0;
    int right = nums.length - 1;
    left = left + 1;
    right -= 1;
    left += 1;
    right = right - 1;
    return nums[left] + nums[right];
  }
}
