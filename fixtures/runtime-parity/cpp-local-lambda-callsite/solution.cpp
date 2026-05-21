class Solution {
public:
  int solve(vector<string>& emails) {
    int merged = 0;
    auto unite = [&](string firstEmail, string email) {
      if (firstEmail != email) {
        merged += 1;
      }
    };
    string firstEmail = emails[0];
    string email = emails[1];
    unite(firstEmail, email);
    return merged;
  }
};
