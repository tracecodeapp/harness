int removedAt(vector<int>& nums) {
  return nums[1];
}

int solve(vector<int>& nums) {
  vector<int> values = nums;
  return values.erase(values.begin() + 1), removedAt(nums);
}
