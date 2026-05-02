function solve(nums) {
  const freq = new Map();
  freq.set(1, 2);
  const left = nums[0];
  freq.set(left, freq.get(left) - 1);
  return freq.get(left);
}
