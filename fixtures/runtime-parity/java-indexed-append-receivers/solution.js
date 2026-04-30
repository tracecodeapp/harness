function solve(nums) {
  const buckets = new Map();
  if (!buckets.has(nums[0])) buckets.set(nums[0], []);
  buckets.get(nums[0]).push(nums[1]);
  const graph = Array.from({ length: 2 }, () => []);
  graph[0].push(nums[2]);
  return buckets.get(nums[0]).length + graph[0].length;
}
