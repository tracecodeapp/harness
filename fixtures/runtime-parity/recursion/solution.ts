function solve(n: number): number {
  if (n <= 1) {
    return 1;
  }
  return n * solve(n - 1);
}
