int solve(vector<int>& nums) {
  int total = 0;
  for (int i = 0; i < nums.size(); i++) {
    int num = nums[i];
    total += num;
  }
  return total;
}
