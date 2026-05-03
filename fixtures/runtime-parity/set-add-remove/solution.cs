using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var seen = new HashSet<int>();
        seen.Add(2);
        seen.Remove(2);
        return seen.Count;
    }
}
