type NodeLike = {
  __id__: string;
  val: number;
  next: NodeLike | null;
};

function solve(): number {
  const next: NodeLike = { __id__: 'list-1', val: 2, next: null };
  const first: NodeLike = { __id__: 'list-0', val: 1, next };
  let cur: NodeLike = first;
  cur = cur.next!;
  return cur.val;
}
