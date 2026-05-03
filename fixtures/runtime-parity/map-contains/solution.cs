using System.Collections.Generic;

public class Solution
{
    public bool solve()
    {
        var seen = new Dictionary<int, int>();
        seen[2] = 5;
        return seen.ContainsKey(2);
    }
}
