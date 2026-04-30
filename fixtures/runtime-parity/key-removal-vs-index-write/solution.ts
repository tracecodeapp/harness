function solve(): number {
  const counts = new Map<string, number>([["a", 2], ["b", 1]]);
  counts.set("a", counts.get("a")! - 1);
  counts.delete("b");
  return (counts.get("a") || 0) + counts.size;
}
