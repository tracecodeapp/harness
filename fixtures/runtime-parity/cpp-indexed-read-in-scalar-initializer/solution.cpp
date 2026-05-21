class Solution {
public:
  int solve() {
    vector<int> d = {1, 0, -1, 0, 1};
    int i = 2;
    int j = 3;
    int ni = i + d[0];
    int nj = j + d[1];
    return ni + nj;
  }
};
