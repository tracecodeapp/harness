using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var heap = new List<int> { 3, 5 };
        heap.RemoveAt(heap.Count - 1);
        heap.RemoveAt(heap.Count - 1); // second removal
        return heap.Count;
    }
}
