class Solution {
  vector<vector<int>> graph;

public:
  vector<vector<int>> solve(int n) {
    this->graph = vector<vector<int>>(n);
    this->graph[0].push_back(1);
    return this->graph;
  }
};
