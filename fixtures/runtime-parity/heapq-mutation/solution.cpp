class Solution {
public:
  int solve(vector<int>& nums) {
    priority_queue<int> heap;
    heap.push(nums[0]);
    int value = heap.top();
    heap.pop();
    return value;
  }
};
