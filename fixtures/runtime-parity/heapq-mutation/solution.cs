using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var heap = new PriorityQueue<int, int>();
        heap.Enqueue(nums[0], nums[0]);
        int value = heap.Dequeue();
        return value;
    }
}
