using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var seen = new Dictionary<int, int>();
        seen[2] = 5;
        return seen[2];
    }
}
