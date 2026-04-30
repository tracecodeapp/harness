function solve(nums: number[]): number {
  const freq = new Map<number, number>([[1, 2]]);
  const left = nums[0];
  freq.set(left, freq.get(left)! - 1);
  return freq.get(left)!;
}
