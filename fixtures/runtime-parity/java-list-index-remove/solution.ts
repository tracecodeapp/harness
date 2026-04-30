function solve(nums: number[]): number {
  const values: number[] = [...nums];
  return values.splice(1, 1)[0]!;
}
