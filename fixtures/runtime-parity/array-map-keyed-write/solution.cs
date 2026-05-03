using System.Collections.Generic;

public class Solution
{
    public int solve(int key)
    {
        var first = new Dictionary<int, int>();
        var second = new Dictionary<int, int>();
        var dp = new[] { first, second };
        dp[1][key] = 3;
        return 1;
    }
}
