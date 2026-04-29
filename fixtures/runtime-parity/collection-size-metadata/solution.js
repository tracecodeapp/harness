function solve(nums) {
  let total = 0;
  const n = nums.length;
  const seen = new Map([[1, true], [2, true]]);
  const m = seen.size;
  return n + m + total;
}
