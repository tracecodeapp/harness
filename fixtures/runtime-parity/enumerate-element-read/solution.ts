function solve(nums: number[]): number {
  let total = 0;
  for (let i = 0; i < nums.length; i++) {
    const num = nums[i];
    total += num;
  }
  return total;
}
