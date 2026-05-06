int solve(vector<int>& nums) {
  deque<int> window(nums.begin(), nums.end());
  int last = window[2];
  return last;
}
