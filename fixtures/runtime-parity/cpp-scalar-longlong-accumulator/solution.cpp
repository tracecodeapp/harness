long long solve(vector<int>& nums) {
  long long low = static_cast<long long>(nums[0]);
  long long high = static_cast<long long>(nums[1]);
  long long count = static_cast<long long>(nums[0])
    + static_cast<long long>(nums[1]);
  count += high - low;
  return count;
}
