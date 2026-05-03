using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var freq = new Dictionary<int, int>();
        int current;

        freq.TryGetValue(1, out current);
        freq[1] = current + 1;
        freq.TryGetValue(2, out current);
        freq[2] = current + 1;
        freq.TryGetValue(1, out current);
        freq[1] = current + 1;

        return freq[1];
    }
}
