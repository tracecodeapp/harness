class Solution {
  vector<vector<int>> values = {{2, 5}, {9, 4}};
public:
  vector<vector<int>> solve() {
    int picked = this->values[0][1];
    this->values[1][0] = picked + this->values[0][0];
    return this->values;
  }
};
