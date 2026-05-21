using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        int[] values = new[] { 2, 1 };
        var queue = new Queue<int>();
        int fresh = 0;
        foreach (int value in values)
        {
            if (value == 2) queue.Enqueue(value);
            else if (value == 1) fresh++;
        }
        return fresh + queue.Count;
    }
}
