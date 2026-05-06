int solve(vector<int>& nums) {
  unordered_map<int, int> freq;
  freq[1] = (freq.count(1) ? freq[1] : 0) + 1;
  freq[2] = (freq.count(2) ? freq[2] : 0) + 1;
  freq[1] = (freq.count(1) ? freq[1] : 0) + 1;
  return freq.raw()[1];
}
