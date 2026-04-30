function solve(nums) {
  const queue = [];
  for (const num of nums) {
    queue.push(num);
  }
  const first = queue.shift();
  return first;
}
