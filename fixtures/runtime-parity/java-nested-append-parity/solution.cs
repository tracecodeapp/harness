using System.Collections.Generic;

public class Bucket
{
    public List<int> keys = new List<int>();
}

public class Solution
{
    public List<int> solve(int n)
    {
        var graph = new Dictionary<int, List<int>>();
        graph[0] = new List<int>();
        graph[0].Add(1);

        var bucket = new Bucket();
        bucket.keys.Add(2);

        return graph[0];
    }
}
