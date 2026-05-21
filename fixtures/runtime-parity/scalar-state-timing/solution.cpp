int solve(vector<int>& nums) {
  int left = 0;
  int right = (int)nums.size() - 1;
  left = left + 1;
  right -= 1;
  left += 1;
  right = right - 1;
  return nums[left] + nums[right];
}
