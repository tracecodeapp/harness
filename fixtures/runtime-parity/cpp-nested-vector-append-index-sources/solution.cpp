vector<vector<int>> solve() {
  vector<vector<int>> edges = {{1, 2}};
  vector<vector<int>> adj(3);
  vector<int> e = edges[0];
  adj[e[0]].push_back(e[1]);
  return adj;
}
