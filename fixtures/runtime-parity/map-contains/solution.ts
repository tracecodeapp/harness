function solve(): boolean {
  const seen = new Map<number, number>();
  seen.set(2, 5);
  return seen.has(2);
}
