function solve(items: string[]): number {
  const seen = new Map<string, number>();
  for (const item of items) {
    seen.set(item, item.length);
  }
  return seen.get(items[0])!;
}
