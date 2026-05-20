function solve(): number {
  const edges: number[][] = [[0, 1, 5], [1, 2, 7]];
  const directions: number[][] = [[1, 0], [0, 1]];
  const valueToOwners = new Map<string, number[]>([['a', [1, 2]]]);
  const email = 'a';
  const adj = new Map<string, Set<string>>([['a', new Set<string>()], ['b', new Set<string>()]]);
  const inDegree = new Map<string, number>();
  let total = 0;
  for (const [u, v, w] of edges) {
    total += u + v + w;
  }
  for (const [di, dj] of directions) {
    total += di + dj;
  }
  for (const owner of valueToOwners.get(email) ?? []) {
    total += owner;
  }
  for (const ch of adj.keys()) inDegree.set(ch, 0);
  return total + inDegree.size;
}
