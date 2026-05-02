class Solution {
public:
  int solve(vector<int>& nums) {
    queue<int> queue;
    for (int num : nums) {
      queue.push(num);
    }
    int first = queue.front();
    queue.pop();
    return first;
  }
};
