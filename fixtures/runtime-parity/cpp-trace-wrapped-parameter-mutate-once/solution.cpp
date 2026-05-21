class Solution {
public:
  int solve() {
    vector<int> nums = {1};
    vector<int> current;
    backtrack(nums, current);
    return 0;
  }

  void backtrack(vector<int>& nums, vector<int>& current) {
    current.push_back(nums[0]);
    current.pop_back();
  }
};
