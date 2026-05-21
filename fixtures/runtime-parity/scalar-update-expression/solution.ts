function solve(nums: number[]): number {
  let left = 0;
  let right = nums.length - 1;
  left++;
  --right;
  const picked = nums[left++];
  return picked + nums[left] + nums[right];
}
