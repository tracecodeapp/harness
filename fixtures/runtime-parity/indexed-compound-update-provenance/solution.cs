public class Solution
{
    public int solve()
    {
        int[] dp = new[] { 1, 0, 0 };
        int num = 1;
        int idx = 1;
        dp[idx] += dp[idx - num];
        return dp[idx];
    }
}
