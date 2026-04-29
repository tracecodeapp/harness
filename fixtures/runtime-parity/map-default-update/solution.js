function solve(nums) {
  const freq = new Map();
  freq.set(1, (freq.get(1) || 0) + 1);
  freq.set(2, (freq.get(2) || 0) + 1);
  freq.set(1, (freq.get(1) || 0) + 1);
  return freq.get(1);
}
