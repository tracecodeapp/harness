int solve(vector<int>& nums) {
  unordered_map<int, vector<int>> buckets;
  if (!buckets.count(nums[0])) buckets[nums[0]] = vector<int>();
  buckets[nums[0]].push_back(nums[1]);
  vector<vector<int>> graph(2);
  graph[0].push_back(nums[2]);
  return buckets[nums[0]].size() + graph[0].size();
}
