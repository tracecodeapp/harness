class Solution {
public:
  int solve(vector<vector<string>>& accounts) {
    for (const auto& account : accounts) {
      int i = 1;
      string email = account[i];
      return (int)email.size();
    }
    return 0;
  }
};
