function solve(n: number): number {
  let i = 0;
  let total = 0;
  while (i < n) {
    total += i;
    i += 1;
  }
  return total;
}
