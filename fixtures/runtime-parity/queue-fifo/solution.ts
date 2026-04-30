function solve(nums: number[]): number {
  const queue: number[] = [];
  for (const num of nums) {
    queue.push(num);
  }
  const first = queue.shift()!;
  return first;
}
