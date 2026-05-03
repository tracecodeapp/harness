using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var buckets = new Dictionary<int, List<int>>();
        buckets[nums[0]] = new List<int>();
        buckets[nums[0]].Add(nums[1]);

        var graph = new List<List<int>>();
        graph.Add(new List<int>());
        graph[0].Add(nums[2]);

        return buckets[nums[0]].Count + graph[0].Count;
    }
}
