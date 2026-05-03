using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var counts = new Dictionary<string, int>
        {
            ["a"] = 2,
            ["b"] = 1,
        };

        counts["a"] = counts["a"] - 1;
        counts.Remove("b");
        return counts["a"] + counts.Count;
    }
}
