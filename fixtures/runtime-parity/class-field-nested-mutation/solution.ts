class Solution {
  graph: number[][];

  constructor() {
    this.graph = [];
  }

  solve(n: number): number[][] {
    this.graph = Array.from({ length: n }, () => []);
    this.graph[0].push(1);
    return this.graph;
  }
}
