function solve(): number {
  const seen = new Map<number, number>();
  seen.set(2, 5);
  seen.delete(2);
  return seen.size;
}
