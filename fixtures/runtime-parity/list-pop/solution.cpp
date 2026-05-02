class Solution {
public:
  int solve(vector<int>& nums) {
    int value = nums.back();
    nums.pop_back();
    return value;
  }
};
