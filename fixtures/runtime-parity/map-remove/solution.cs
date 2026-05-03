using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var seen = new Dictionary<int, int> { [2] = 5 };
        seen.Remove(2);
        return seen.Count;
    }
}
