function solve(): number {
  const seen = new Set<number>();
  seen.add(2);
  seen.delete(2);
  return seen.size;
}
