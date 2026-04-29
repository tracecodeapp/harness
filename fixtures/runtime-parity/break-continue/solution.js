function solve(nums) {
  let total = 0;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] < 0) {
      continue;
    }
    if (nums[i] === 0) {
      break;
    }
    total += nums[i];
  }
  return total;
}
