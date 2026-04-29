function solve(): boolean {
  const seen = new Set<number>();
  seen.add(2);
  return seen.has(2);
}
