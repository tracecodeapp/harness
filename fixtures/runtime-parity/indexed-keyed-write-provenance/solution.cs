using System.Collections.Generic;

public class Solution
{
    public int solve(string[] items)
    {
        var seen = new Dictionary<string, int>();
        foreach (var item in items)
        {
            seen[item] = item.Length;
        }
        return seen[items[0]];
    }
}
