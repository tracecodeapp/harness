function solve(n) {
  const graph = new Map();
  graph.set(0, []);
  graph.get(0).push(1);
  return graph.get(0);
}
