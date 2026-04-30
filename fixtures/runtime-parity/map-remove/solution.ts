function solve(): number {
  const seen = new Map<number, number>([[2, 5]]);
  seen.delete(2);
  return seen.size;
}
