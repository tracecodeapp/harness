function solve() {
  const edges = [[0, 1, 5], [1, 2, 7]];
  const directions = [[1, 0], [0, 1]];
  const valueToOwners = new Map([['a', [1, 2]]]);
  const email = 'a';
  const adj = new Map([['a', new Set()], ['b', new Set()]]);
  const inDegree = new Map();
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
