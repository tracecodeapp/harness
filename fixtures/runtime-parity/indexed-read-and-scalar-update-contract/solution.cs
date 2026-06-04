using System;

public class Solution
{
    public int solve(string s, int[] nums)
    {
        int right = 2;
        int left = 0;
        int best = 0;
        char ch = s[right];
        int picked = nums[right];
        best = Math.Max(best, right - left + 1);
        return best + picked + (ch == '\0' ? 0 : 1);
    }
}
