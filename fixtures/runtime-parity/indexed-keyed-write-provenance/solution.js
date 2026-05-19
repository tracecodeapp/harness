function solve(items) {
  const seen = new Map();
  for (const item of items) {
    seen.set(item, item.length);
  }
  return seen.get(items[0]);
}
