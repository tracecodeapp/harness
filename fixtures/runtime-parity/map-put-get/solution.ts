function solve(): number {
  const seen = new Map<number, number>();
  seen.set(2, 5);
  return seen.get(2)!;
}
