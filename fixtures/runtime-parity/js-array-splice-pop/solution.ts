function solve(nums: number[]): number {
  const value = nums.splice(nums.length - 1, 1)[0]!;
  return value;
}
