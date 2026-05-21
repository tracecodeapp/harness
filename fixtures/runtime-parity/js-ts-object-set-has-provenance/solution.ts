type NodeLike = { __id__: string; value: number };

function solve(): boolean {
  const first: NodeLike = { __id__: 'n0', value: 1 };
  const seen = new Set<NodeLike>();
  seen.add(first);
  return seen.has(first);
}
