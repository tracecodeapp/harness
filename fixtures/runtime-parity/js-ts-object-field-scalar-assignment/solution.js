function solve() {
  const next = { __id__: 'list-1', val: 2, next: null };
  const first = { __id__: 'list-0', val: 1, next };
  let cur = first;
  cur = cur.next;
  return cur.val;
}
