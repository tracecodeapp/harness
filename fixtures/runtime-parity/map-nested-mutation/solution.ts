function solve(n: number): number[] {
  const graph = new Map<number, number[]>();
  graph.set(0, []);
  graph.get(0)!.push(1);
  return graph.get(0)!;
}
