class Solution {
public:
  int solve(string s, vector<int>& nums) {
    int right = 2;
    int left = 0;
    int best = 0;
    char ch = s[right];
    int picked = nums[right];
    best = max(best, right - left + 1);
    return best + picked + (ch ? 1 : 0);
  }
};
