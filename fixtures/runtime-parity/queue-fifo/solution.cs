using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var queue = new Queue<int>();
        foreach (int num in nums)
        {
            queue.Enqueue(num);
        }

        int first = queue.Dequeue();
        return first;
    }
}
