class Solution {
  constructor() {
    this.graph = [];
  }

  solve(n) {
    this.graph = Array.from({ length: n }, () => []);
    this.graph[0].push(1);
    return this.graph;
  }
}
