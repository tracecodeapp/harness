using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var heap = new List<int> { 1, 2 };
        int parent = 0;
        int index = 1;
        (heap[parent], heap[index]) = (heap[index], heap[parent]);
        return heap[0];
    }
}
