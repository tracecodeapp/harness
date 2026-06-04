function solve(s, nums) {
  let right = 2;
  let left = 0;
  let best = 0;
  const ch = s[right];
  const picked = nums[right];
  best = Math.max(best, right - left + 1);
  return best + picked + ch.length;
}
