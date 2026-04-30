function solve(nums: number[]): number | undefined {
  const heap: number[] = [];
  heap.push(nums[0]);
  const value = heap.pop();
  return value;
}
