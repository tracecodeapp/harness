int solve(vector<int>& nums) {
  unordered_map<int, int> freq;
  freq[1] = 2;
  int left = nums[0];
  freq[left] = freq[left] - 1;
  return freq[left];
}
