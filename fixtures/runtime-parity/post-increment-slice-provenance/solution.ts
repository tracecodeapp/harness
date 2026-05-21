function solve(nums: number[]): number {
  const left = nums.slice(0, 2);
  const merged = [0, 0];
  let i = 0;
  let k = 0;
  const pulled = left[i++];
  merged[k++] = pulled;
  const mid = 2;
  const tail = nums.slice(mid);
  const head = nums.slice(0, mid);
  return merged[0] + tail[0] + head[0] + i + k;
}
