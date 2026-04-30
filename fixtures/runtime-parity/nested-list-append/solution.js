function solve(n) {
  const graph = Array.from({ length: n }, () => []);
  graph[0].push(1);
  return graph;
}
