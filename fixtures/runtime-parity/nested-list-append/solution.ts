function solve(n: number): number[][] {
  const graph: number[][] = Array.from({ length: n }, () => []);
  graph[0].push(1);
  return graph;
}
