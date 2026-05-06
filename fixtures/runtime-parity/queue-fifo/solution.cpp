class Solution {
public:
  int solve(vector<int>& nums) {
    queue<int> queue;
    for (int num : nums) {
      queue.push(num);
    }
    queue.pop();
    return nums.raw()[0];
  }
};
