class Solution {
public:
  int solve(vector<int>& nums) {
    priority_queue<int> heap;
    heap.push(nums[0]);
    heap.pop();
    return nums.raw()[0];
  }
};
