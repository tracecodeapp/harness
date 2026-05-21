class Solution {
public:
  int solve(vector<int>& nums) {
    vector<int> left(nums.begin(), nums.begin() + 2);
    vector<int> merged = { 0, 0 };
    int i = 0;
    int k = 0;
    int pulled = left[i++];
    merged[k++] = pulled;
    int mid = 2;
    vector<int> tail(nums.begin() + mid, nums.end());
    vector<int> head(nums.begin(), nums.begin() + mid);
    return merged[0] + tail[0] + head[0] + i + k;
  }
};
