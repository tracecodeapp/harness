using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var rightIndex = new Dictionary<(int, int), int>();
        int r = 0;
        int c = 1;
        rightIndex[(r, c)] = 7;
        return rightIndex[(r, c)];
    }
}
