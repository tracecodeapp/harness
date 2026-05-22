function solve(): number {
  const prerequisites: number[][] = [[1, 0], [2, 1]];
  let total = 0;
  for (const [course, prereq] of prerequisites) {
    total += course * 10 + prereq;
  }
  return total;
}
