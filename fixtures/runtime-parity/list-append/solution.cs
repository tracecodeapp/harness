using System.Collections.Generic;

public class Solution
{
    public int[] solve(int[] nums)
    {
        var outList = new List<int>();
        foreach (int num in nums)
        {
            outList.Add(num);
        }

        return outList.ToArray();
    }
}
