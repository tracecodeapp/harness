int solve(vector<int>& nums) {
  int left = 0;
  int right = (int)nums.size() - 1;
  left++;
  --right;
  int picked = nums[left++];
  return picked + nums[left] + nums[right];
}
