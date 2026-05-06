int solve(vector<int>& nums) {
  deque<int> deck;
  deck.push_front(nums[0]);
  deck.push_back(nums[0]);
  deck.push_back(nums[1]);
  deck.pop_front(); // pollFirst
  deck.push_back(nums[2]);
  deck.pop_front(); // removeFirst
  deck.pop_back(); // pollLast
  deck.push_back(nums[3]);
  deck.pop_back(); // removeLast
  return deck.size();
}
