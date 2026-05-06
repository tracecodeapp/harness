int solve(vector<int>& nums) {
  int total = 0;
  int n = nums.size();
  unordered_map<int, bool> seen{{1, true}, {2, true}};
  int m = seen.size();
  return n + m + total;
}
