function solve(nums: number[]): number {
  let left = 0;
  let right = nums.length - 1;
  left = left + 1;
  right -= 1;
  left += 1;
  right = right - 1;
  return nums[left] + nums[right];
}
