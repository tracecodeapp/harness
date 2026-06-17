using System;
using System.Collections.Generic;

public class Solution
{
    public int[] TwoSum(int[] nums, int target)
    {
        var seen = new Dictionary<int, int>();

        for (int i = 0; i < nums.Length; i++)
        {
            int need = target - nums[i];

            if (seen.ContainsKey(need))
            {
                return new[] { seen[need], i };
            }

            seen[nums[i]] = i;
        }

        return Array.Empty<int>();
    }
}

