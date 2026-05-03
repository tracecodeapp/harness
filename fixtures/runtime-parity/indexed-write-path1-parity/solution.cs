using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var freq = new Dictionary<int, int> { [1] = 2 };
        int left = nums[0];
        freq[left] = freq[left] - 1;
        return freq[left];
    }
}
