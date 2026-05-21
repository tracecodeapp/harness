class Solution {
public:
  int solve() {
    unordered_map<char, vector<char>> adj;
    adj['t'] = vector<char>{'f'};
    int total = 0;
    for (const auto& [ch, nexts] : adj) {
      total += (ch == 't' ? 10 : 0);
      total += (!nexts.empty() && nexts[0] == 'f') ? 1 : 0;
    }
    return total;
  }
};
