class Solution {
public:
  int solve() {
    vector<pair<int, int>> prerequisites{{1, 0}, {2, 1}};
    int total = 0;
    for (auto [course, prereq] : prerequisites) {
      total += course * 10 + prereq;
    }
    return total;
  }
};
