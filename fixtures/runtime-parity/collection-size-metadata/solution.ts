function solve(nums: number[]): number {
  let total = 0;
  const n = nums.length;
  const seen = new Map<number, boolean>([[1, true], [2, true]]);
  const m = seen.size;
  return n + m + total;
}
