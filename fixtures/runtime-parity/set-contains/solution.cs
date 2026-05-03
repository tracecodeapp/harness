using System.Collections.Generic;

public class Solution
{
    public bool solve()
    {
        var seen = new HashSet<int>();
        seen.Add(2);
        return seen.Contains(2);
    }
}
