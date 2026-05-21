function solve(): number {
  const dp = [1, 0, 0];
  const num = 1;
  const idx = 1;
  dp[idx] += dp[idx - num];
  return dp[idx];
}
