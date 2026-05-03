using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var window = new List<int>(nums);
        int last = window[2];
        return last;
    }
}
