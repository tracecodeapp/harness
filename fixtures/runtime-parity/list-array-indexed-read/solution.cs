using System.Collections.Generic;

public class Solution
{
    public int solve(int[][] rows)
    {
        var values = new List<int[]>();
        values.Add(rows[0]);
        values.Add(rows[1]);
        int total = values[0][1] + values[1][0];
        return total;
    }
}
