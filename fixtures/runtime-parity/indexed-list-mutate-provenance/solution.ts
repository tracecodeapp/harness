function solve(): number {
  const graph: number[][] = [[], []];
  const i = 1;
  const j = 7;
  graph[i].push(j);
  return graph[i][0];
}
