class Solution {
public:
  int solve() {
    vector<vector<int>> graph(2);
    int i = 1;
    int j = 7;
    graph[i].push_back(j);
    return graph[i][0];
  }
};
