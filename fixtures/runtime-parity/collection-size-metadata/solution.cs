using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        int total = 0;
        int n = nums.Length;
        var seen = new Dictionary<int, bool>(new Dictionary<int, bool> { [1] = true, [2] = true });
        int m = seen.Count;
        return n + m + total;
    }
}
